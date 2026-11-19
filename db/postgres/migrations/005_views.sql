-- ============================================================================
-- 005_views.sql  -  reporting views (leaderboard + admin analytics)
-- ============================================================================

-- Per-category leaderboard of VERIFIED workers, ranked by the Bayesian rating.
CREATE VIEW v_worker_leaderboard AS
SELECT
    c.category_id,
    c.name                                         AS category_name,
    w.worker_id,
    w.name,
    w.locality,
    w.avg_rating,
    w.rating_count,
    fn_bayesian_rating(w.avg_rating, w.rating_count) AS bayesian_score,
    coalesce(j.completed_jobs, 0)                  AS completed_jobs,
    RANK() OVER (PARTITION BY c.category_id
                 ORDER BY fn_bayesian_rating(w.avg_rating, w.rating_count) DESC, w.rating_count DESC) AS rank_in_category
FROM worker w
JOIN worker_category wc ON wc.worker_id = w.worker_id
JOIN service_category c ON c.category_id = wc.category_id
LEFT JOIN (
    SELECT worker_id, count(*)::int AS completed_jobs FROM booking WHERE status = 'completed' GROUP BY worker_id
) j ON j.worker_id = w.worker_id
WHERE w.verification_status = 'verified';

-- Money actually kept by the platform per payment (paid minus refunded).
CREATE VIEW v_net_payment AS
SELECT p.payment_id, p.invoice_id, i.booking_id, p.paid_at, p.amount - p.refund_amount AS net_amount
FROM payment p JOIN invoice i ON i.invoice_id = p.invoice_id
WHERE p.status IN ('success', 'refunded', 'partially_refunded');

-- One-row KPI summary for the admin dashboard.
CREATE VIEW v_platform_kpis AS
SELECT
    (SELECT count(*) FROM booking)                                    AS total_bookings,
    (SELECT count(*) FROM booking WHERE status = 'confirmed')         AS confirmed,
    (SELECT count(*) FROM booking WHERE status = 'completed')         AS completed,
    (SELECT count(*) FROM booking WHERE status = 'cancelled')         AS cancelled,
    (SELECT count(*) FROM booking WHERE status = 'no_show')           AS no_shows,
    (SELECT coalesce(sum(net_amount), 0) FROM v_net_payment)          AS net_revenue,
    (SELECT round(avg(score)::numeric, 2) FROM rating)                AS avg_rating,
    (SELECT count(*) FROM worker WHERE verification_status = 'verified') AS verified_workers,
    (SELECT count(*) FROM worker WHERE verification_status = 'pending')  AS pending_workers,
    (SELECT count(*) FROM dispute WHERE status = 'open')              AS open_disputes,
    (SELECT round(100.0 * count(*) FILTER (WHERE status = 'no_show')
                  / nullif(count(*) FILTER (WHERE status IN ('completed', 'no_show')), 0), 1)
     FROM booking)                                                    AS no_show_rate_pct;

-- Bookings and revenue per category.
CREATE VIEW v_category_stats AS
SELECT
    c.category_id,
    c.name AS category_name,
    count(DISTINCT b.booking_id)                                              AS bookings,
    count(DISTINCT b.booking_id) FILTER (WHERE b.status = 'completed')        AS completed,
    coalesce(sum(n.net_amount), 0)                                            AS net_revenue
FROM service_category c
LEFT JOIN worker_category wc ON wc.category_id = c.category_id
LEFT JOIN booking b          ON b.worker_id = wc.worker_id
LEFT JOIN v_net_payment n    ON n.booking_id = b.booking_id
GROUP BY c.category_id, c.name;

-- Net revenue per day (IST) for the last 30 days.
CREATE VIEW v_revenue_by_day AS
SELECT (paid_at AT TIME ZONE 'Asia/Kolkata')::date AS day, sum(net_amount) AS net_revenue, count(*) AS payments
FROM v_net_payment
WHERE paid_at >= now() - interval '30 days'
GROUP BY 1;
