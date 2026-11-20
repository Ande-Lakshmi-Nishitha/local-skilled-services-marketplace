-- ============================================================================
-- report_queries.sql  -  the DML / query demonstration used in the project report.
-- Run:  psql "$POSTGRES_URL" -f db/postgres/queries/report_queries.sql
-- Everything that changes data is wrapped in a transaction that ends in ROLLBACK,
-- so the demo data is untouched afterwards.
-- ============================================================================
\set ON_ERROR_STOP off
\pset border 2
\pset null '-'

\echo '=== A. DML: INSERT / UPDATE / DELETE (inside a transaction, rolled back) ==='
BEGIN;

\echo '--- A1. INSERT a customer, a service request and a new availability slot'
INSERT INTO customer (name, email, phone, locality)
VALUES ('Report Demo', 'report.demo@example.com', '+91-98000-99999', 'Indiranagar')
RETURNING customer_id, name, locality;

INSERT INTO service_request (customer_id, description)
SELECT customer_id, 'Kitchen tap leaks continuously, needs a new washer'
FROM customer WHERE email = 'report.demo@example.com'
RETURNING request_id, customer_id, description, status;

INSERT INTO availability_slot (worker_id, start_time, end_time)
VALUES (2, date_trunc('hour', now()) + interval '90 days', date_trunc('hour', now()) + interval '90 days 2 hours')
RETURNING slot_id, worker_id, status;

\echo '--- A2. UPDATE: a worker changes the hourly rate; admin verifies a pending worker (procedure)'
UPDATE worker SET hourly_rate = 475.00 WHERE worker_id = 2 RETURNING worker_id, name, hourly_rate;
CALL sp_review_worker(5, 1, 'verified');
SELECT worker_id, name, verification_status, verified_by FROM worker WHERE worker_id = 5;

\echo '--- A3. DELETE: remove an open slot (allowed) and try to delete a reserved slot (blocked by trigger T5)'
DELETE FROM availability_slot
WHERE slot_id = (SELECT max(slot_id) FROM availability_slot WHERE status = 'open')
RETURNING slot_id, status;
SAVEPOINT s1;
DELETE FROM availability_slot WHERE slot_id = (SELECT slot_id FROM availability_slot WHERE status = 'reserved' LIMIT 1);
ROLLBACK TO SAVEPOINT s1;
ROLLBACK;

\echo
\echo '=== B. Stored procedures: book -> pay -> cancel with refund (all-or-nothing) ==='
BEGIN;
DO $$
DECLARE
    v_req int := 194;                   -- "Damp patch spreading on the bedroom wall" (customer 5)
    v_cust int; v_w int; v_slot int; v_b int; v_i int; v_p int; v_ref numeric; v_pol text;
BEGIN
    SELECT customer_id INTO v_cust FROM service_request WHERE request_id = v_req;
    SELECT worker_id, next_slot_id INTO v_w, v_slot FROM fn_match_workers(v_req) LIMIT 1;
    RAISE NOTICE 'best match for request %: worker % (slot %)', v_req, v_w, v_slot;
    CALL sp_create_booking(v_cust, v_req, v_w, v_slot, v_b, v_i);
    RAISE NOTICE 'booking % created, invoice % issued', v_b, v_i;
    CALL sp_pay_invoice(v_i, v_cust, 'upi', v_p);
    RAISE NOTICE 'payment % recorded', v_p;
    CALL sp_cancel_booking(v_b, 'customer', v_cust, v_ref, v_pol);
    RAISE NOTICE 'cancelled by customer: refund % (policy: %)', v_ref, v_pol;
    RAISE NOTICE 'booking status = %, slot status = %, invoice status = %',
        (SELECT status FROM booking WHERE booking_id = v_b),
        (SELECT status FROM availability_slot WHERE slot_id = v_slot),
        (SELECT status FROM invoice WHERE invoice_id = v_i);
END $$;
ROLLBACK;

\echo
\echo '=== C. Constraints and triggers rejecting bad data ==='
BEGIN;
INSERT INTO availability_slot (worker_id, start_time, end_time)   -- an open slot for the still-pending worker 5
VALUES (5, date_trunc('hour', now()) + interval '40 days', date_trunc('hour', now()) + interval '40 days 2 hours');
DO $$
DECLARE
    v_slot record; v_free record; v_other int; v_b int; v_i int; v_inv int; v_pend int;
BEGIN
    SELECT slot_id, worker_id, start_time, end_time INTO v_slot FROM availability_slot WHERE status = 'reserved' LIMIT 1;
    SELECT slot_id, worker_id INTO v_free FROM availability_slot WHERE status = 'open' AND start_time > now() LIMIT 1;
    SELECT worker_id INTO v_other FROM worker WHERE worker_id <> v_free.worker_id LIMIT 1;
    SELECT invoice_id INTO v_inv FROM invoice WHERE status = 'issued' LIMIT 1;
    SELECT slot_id INTO v_pend FROM availability_slot WHERE status = 'open' AND start_time > now() AND worker_id = 5 LIMIT 1;
    BEGIN   -- C1 overlapping slot (exclusion constraint)
        INSERT INTO availability_slot (worker_id, start_time, end_time)
        VALUES (v_slot.worker_id, v_slot.start_time + interval '30 minutes', v_slot.end_time + interval '30 minutes');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C1 overlapping slot   -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
    BEGIN   -- C2 double booking of an already reserved slot
        CALL sp_create_booking(1, 194, v_slot.worker_id, v_slot.slot_id, v_b, v_i);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C2 double booking     -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
    BEGIN   -- C3 illegal status transition (completed -> confirmed)
        UPDATE booking SET status = 'confirmed' WHERE booking_id = (SELECT min(booking_id) FROM booking WHERE status = 'completed');
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C3 status transition  -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
    BEGIN   -- C4 rating a booking that is not completed
        INSERT INTO rating (booking_id, score) SELECT booking_id, 5 FROM booking WHERE status = 'confirmed' LIMIT 1;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C4 rating unfinished  -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
    BEGIN   -- C5 rating out of range (CHECK)
        INSERT INTO rating (booking_id, score) SELECT booking_id, 9 FROM booking WHERE status = 'completed' LIMIT 1;
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C5 score = 9          -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
    BEGIN   -- C6 booking one worker's slot under another worker's name (composite foreign key)
        INSERT INTO booking (request_id, worker_id, slot_id) VALUES (194, v_other, v_free.slot_id);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C6 wrong worker/slot  -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
    BEGIN   -- C7 a customer paying somebody else's invoice
        CALL sp_pay_invoice(v_inv, 99, 'upi', v_i);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C7 foreign invoice    -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
    BEGIN   -- C8 a pending worker cannot be booked
        CALL sp_create_booking(1, 194, 5, v_pend, v_b, v_i);
    EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'C8 unverified worker  -> SQLSTATE % : %', SQLSTATE, SQLERRM; END;
END $$;
ROLLBACK;

\echo '=== D. SELECT queries ==='

\echo '--- D1. JOIN (5 tables): latest completed jobs with customer, worker, category, slot and amount'
SELECT b.booking_id, c.name AS customer, w.name AS worker, sc.name AS category,
       to_char(s.start_time AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS slot_ist, i.amount
FROM booking b
JOIN service_request r   ON r.request_id  = b.request_id
JOIN customer c          ON c.customer_id = r.customer_id
JOIN worker w            ON w.worker_id   = b.worker_id
JOIN worker_category wc  ON wc.worker_id  = w.worker_id
JOIN service_category sc ON sc.category_id = wc.category_id
JOIN availability_slot s ON s.slot_id     = b.slot_id
JOIN invoice i           ON i.booking_id  = b.booking_id
WHERE b.status = 'completed'
ORDER BY s.start_time DESC, b.booking_id LIMIT 6;

\echo '--- D2. LEFT JOIN + GROUP BY + HAVING: workers with at least 6 completed jobs and their earnings'
SELECT w.worker_id, w.name, count(b.booking_id) AS completed_jobs, coalesce(sum(i.amount), 0) AS billed
FROM worker w
LEFT JOIN booking b ON b.worker_id = w.worker_id AND b.status = 'completed'
LEFT JOIN invoice i ON i.booking_id = b.booking_id
GROUP BY w.worker_id, w.name
HAVING count(b.booking_id) >= 6
ORDER BY completed_jobs DESC, w.worker_id LIMIT 6;

\echo '--- D3. NESTED query (subquery in WHERE): workers rated above the platform-wide average score'
SELECT worker_id, name, avg_rating, rating_count
FROM worker
WHERE avg_rating > (SELECT avg(score) FROM rating)
ORDER BY avg_rating DESC, rating_count DESC LIMIT 6;

\echo '--- D4. NESTED query with IN: customers who have booked a plumber'
SELECT customer_id, name FROM customer
WHERE customer_id IN (
    SELECT r.customer_id FROM service_request r
    JOIN booking b ON b.request_id = r.request_id
    WHERE b.worker_id IN (SELECT wc.worker_id FROM worker_category wc
                          JOIN service_category sc ON sc.category_id = wc.category_id WHERE sc.name = 'Plumber'))
ORDER BY customer_id;

\echo '--- D5. CORRELATED subquery: workers who completed more jobs than the average worker of THEIR OWN locality'
SELECT w.worker_id, w.name, w.locality,
       (SELECT count(*) FROM booking b WHERE b.worker_id = w.worker_id AND b.status = 'completed') AS jobs
FROM worker w
WHERE (SELECT count(*) FROM booking b WHERE b.worker_id = w.worker_id AND b.status = 'completed') >
      (SELECT avg(cnt) FROM (SELECT count(*) AS cnt
                             FROM worker w2 LEFT JOIN booking b2 ON b2.worker_id = w2.worker_id AND b2.status = 'completed'
                             WHERE w2.locality = w.locality GROUP BY w2.worker_id) x)
ORDER BY jobs DESC, w.worker_id LIMIT 6;

\echo '--- D6. CORRELATED NOT EXISTS: open requests that nobody has booked yet'
SELECT r.request_id, c.name AS customer, left(r.description, 60) AS description
FROM service_request r JOIN customer c ON c.customer_id = r.customer_id
WHERE r.status = 'open'
  AND NOT EXISTS (SELECT 1 FROM booking b WHERE b.request_id = r.request_id AND b.status <> 'cancelled')
ORDER BY r.request_id;

\echo '--- D7. RECURSIVE CTE: revenue for each of the last 14 days, including days with no payments'
WITH RECURSIVE days(d) AS (
    SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date - 13
    UNION ALL
    SELECT d + 1 FROM days WHERE d < (now() AT TIME ZONE 'Asia/Kolkata')::date
)
SELECT days.d AS day, coalesce(v.net_revenue, 0) AS net_revenue, coalesce(v.payments, 0) AS payments
FROM days LEFT JOIN v_revenue_by_day v ON v.day = days.d
ORDER BY days.d;

\echo '--- D8. CTE + window function: top 2 workers in each category (leaderboard view)'
WITH ranked AS (
    SELECT category_name, name, avg_rating, rating_count, bayesian_score, rank_in_category
    FROM v_worker_leaderboard
)
SELECT * FROM ranked WHERE rank_in_category <= 2 ORDER BY category_name, rank_in_category, name;

\echo '--- D9. VIEW: platform KPIs and category statistics'
\x on
SELECT * FROM v_platform_kpis;
\x off
SELECT category_name, bookings, completed, net_revenue FROM v_category_stats ORDER BY net_revenue DESC;

\echo '--- D10. FUNCTION: Bayesian rating (one 5-star review is pulled towards the prior)'
SELECT fn_bayesian_rating(5.0, 1) AS one_five_star, fn_bayesian_rating(4.5, 40) AS forty_reviews, fn_bayesian_rating(NULL, 0) AS no_reviews;
