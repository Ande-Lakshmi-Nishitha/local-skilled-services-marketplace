-- ============================================================================
-- seed/002_slots_and_history.sql
--   * open availability: next 7 days x three 2-hour windows (IST) for every verified worker
--   * past completed jobs with invoices, payments and ratings, so trust ranking and
--     leaderboards have real signal. Ratings go through the triggers (avg is recomputed).
-- The number of past jobs varies per worker (1..9) on purpose: it shows why the
-- Bayesian rating matters (one 5-star review must not beat many 4.6 reviews).
-- ============================================================================

INSERT INTO availability_slot (worker_id, start_time, end_time)
SELECT w.worker_id,
       ((current_date + d) + t.s) AT TIME ZONE 'Asia/Kolkata',
       ((current_date + d) + t.e) AT TIME ZONE 'Asia/Kolkata'
FROM worker w
CROSS JOIN generate_series(1, 7) AS d
CROSS JOIN (VALUES (time '10:00', time '12:00'),
                   (time '14:00', time '16:00'),
                   (time '17:00', time '19:00')) AS t(s, e)
WHERE w.verification_status = 'verified';

DO $$
DECLARE
    w        record;
    i        integer;
    n_jobs   integer;
    cust_ids integer[];
    v_req    integer;
    v_slot   integer;
    v_book   integer;
    v_inv    integer;
    v_amount numeric(10,2);
    v_start  timestamptz;
    v_score  integer;
    comments text[] := ARRAY[
        'Arrived on time and fixed it quickly.',
        'Good work, fair price.',
        'Professional and tidy.',
        'Took longer than expected but the result is fine.',
        'Excellent, would book again.',
        'Explained the problem clearly before starting.',
        NULL];
    v_cat    text;
    jobs     jsonb := '{
      "Electrician":      ["Switchboard sparking in the hall", "Inverter not charging", "Tube light flickering", "New plug point for the washing machine", "Power trips when the geyser is on"],
      "Plumber":          ["Kitchen tap leaking", "Blocked bathroom drain", "Flush not working", "Low water pressure upstairs", "Leak under the wash basin"],
      "Appliance Repair": ["Fridge not cooling", "Washing machine not draining", "AC service before summer", "Microwave not heating", "RO purifier filter change"],
      "Tutor":            ["Maths tuition before exams", "Spoken English practice", "Help with homework", "Science revision classes", "Coding classes for my son"],
      "Home Cleaning":    ["Deep clean before guests", "Kitchen degreasing", "Sofa shampooing", "Daily house help for a week", "Bathroom tiles cleaning"],
      "Carpenter":        ["Wardrobe door repair", "Assemble a new bed", "Kitchen drawer channels replaced", "Fix a jammed door", "Wall shelf installation"],
      "Painter":          ["Repaint the bedroom", "Waterproof the terrace", "Polish the teak dining table", "Accent wall in the living room", "Fix damp patches"],
      "Pest Control":     ["Cockroach treatment", "Termite inspection", "Rats in the store room", "Mosquito fogging", "Bed bug treatment"]
    }'::jsonb;
BEGIN
    SELECT array_agg(customer_id ORDER BY customer_id) INTO cust_ids FROM customer;

    FOR w IN SELECT worker_id, hourly_rate FROM worker WHERE verification_status = 'verified' ORDER BY worker_id LOOP
        n_jobs := 1 + ((w.worker_id * 7) % 9);
        SELECT min(c.name) INTO v_cat FROM worker_category wc JOIN service_category c USING (category_id) WHERE wc.worker_id = w.worker_id;
        FOR i IN 1..n_jobs LOOP
            v_start  := date_trunc('day', now()) - (i * 3 + 5) * interval '1 day' + interval '5 hours';
            v_amount := round(w.hourly_rate * 2, 2);
            v_score  := 2 + ((w.worker_id * 5 + i * 3) % 4);              -- 2..5, deterministic
            IF w.worker_id % 6 = 0 THEN v_score := least(5, v_score + 1); END IF;   -- a few consistently strong workers

            INSERT INTO service_request (customer_id, description, status, created_at)
            VALUES (cust_ids[1 + ((w.worker_id + i) % array_length(cust_ids, 1))],
                    coalesce(jobs -> v_cat ->> ((w.worker_id + i) % 5), 'Home service visit'), 'closed', v_start - interval '2 days')
            RETURNING request_id INTO v_req;

            INSERT INTO availability_slot (worker_id, start_time, end_time, status)
            VALUES (w.worker_id, v_start, v_start + interval '2 hours', 'reserved')
            RETURNING slot_id INTO v_slot;

            INSERT INTO booking (request_id, worker_id, slot_id, status, created_at)
            VALUES (v_req, w.worker_id, v_slot, 'completed', v_start - interval '1 day')
            RETURNING booking_id INTO v_book;

            INSERT INTO invoice (booking_id, amount, status, issued_at)
            VALUES (v_book, v_amount, 'paid', v_start - interval '1 day')
            RETURNING invoice_id INTO v_inv;

            INSERT INTO payment (invoice_id, amount, method, status, paid_at)
            VALUES (v_inv, v_amount, (ARRAY['upi','card','netbanking','cash'])[1 + (i % 4)], 'success', v_start + interval '3 hours');

            INSERT INTO rating (booking_id, score, comment, created_at)
            VALUES (v_book, v_score, comments[1 + ((w.worker_id + i) % array_length(comments, 1))], v_start + interval '1 day');
        END LOOP;
    END LOOP;
END $$;
