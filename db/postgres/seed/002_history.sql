-- ============================================================================
-- seed/002_history.sql - past completed jobs + ratings so leaderboards / trust ranking have signal
-- Inserts directly into the tables (bypasses stored procedures on purpose: those are Person A's work).
-- Works with or without Person A's rating trigger: the last statement recomputes
-- worker.avg_rating / rating_count itself.
-- ============================================================================

DO $$
DECLARE
    w          record;
    i          integer;
    cust_ids   integer[];
    v_cust     integer;
    v_req      integer;
    v_slot     integer;
    v_book     integer;
    v_amount   numeric(10,2);
    v_start    timestamptz;
    v_score    integer;
    comments   text[] := ARRAY[
        'Arrived on time and fixed it quickly.',
        'Good work, fair price.',
        'Professional and tidy.',
        'Took longer than expected but the result is fine.',
        'Excellent - would book again.'];
BEGIN
    SELECT array_agg(customer_id ORDER BY customer_id) INTO cust_ids FROM customer;

    FOR w IN SELECT worker_id, hourly_rate FROM worker WHERE verification_status = 'verified' ORDER BY worker_id LOOP
        FOR i IN 1..4 LOOP
            v_cust   := cust_ids[1 + ((w.worker_id + i) % array_length(cust_ids, 1))];
            v_start  := date_trunc('day', now()) - (i + 5) * interval '1 day' + interval '10 hours';
            v_amount := round(w.hourly_rate * 2, 2);
            v_score  := 3 + ((w.worker_id * i) % 3);            -- 3..5, deterministic

            INSERT INTO service_request (customer_id, description, status, created_at)
            VALUES (v_cust, 'Historical job ' || i || ' for worker ' || w.worker_id, 'closed', v_start - interval '2 days')
            RETURNING request_id INTO v_req;

            INSERT INTO availability_slot (worker_id, start_time, end_time, status)
            VALUES (w.worker_id, v_start, v_start + interval '2 hours', 'reserved')
            RETURNING slot_id INTO v_slot;

            INSERT INTO booking (request_id, worker_id, slot_id, status, created_at)
            VALUES (v_req, w.worker_id, v_slot, 'completed', v_start - interval '1 day')
            RETURNING booking_id INTO v_book;

            INSERT INTO invoice (booking_id, amount, status, issued_at)
            VALUES (v_book, v_amount, 'paid', v_start - interval '1 day');

            INSERT INTO payment (invoice_id, amount, method, status, paid_at)
            SELECT invoice_id, v_amount, 'upi', 'success', v_start + interval '3 hours'
            FROM invoice WHERE booking_id = v_book;

            INSERT INTO rating (booking_id, score, comment, created_at)
            VALUES (v_book, v_score, comments[1 + ((w.worker_id + i) % 5)], v_start + interval '1 day');
        END LOOP;
    END LOOP;
END $$;

-- Self-contained recompute (the real system does this in a trigger).
UPDATE worker w
SET avg_rating   = s.avg_score,
    rating_count = s.cnt
FROM (
    SELECT b.worker_id, round(avg(r.score)::numeric, 2) AS avg_score, count(*)::int AS cnt
    FROM rating r JOIN booking b USING (booking_id)
    GROUP BY b.worker_id
) s
WHERE s.worker_id = w.worker_id;
