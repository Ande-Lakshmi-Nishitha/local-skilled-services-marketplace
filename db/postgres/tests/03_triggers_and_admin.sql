-- Triggers (rating, status machine, no-show, slot guard), overlap constraint, disputes, views.
BEGIN;

UPDATE worker SET verification_status = 'pending', verified_by = NULL WHERE email = 'rekha.nair@example.com';  -- state this test needs (rolled back)

CREATE TEMP TABLE t AS
SELECT pg_temp.wid('ramesh.yadav@example.com') AS w,
       pg_temp.cid('sanjay.hegde@example.com') AS c,
       (SELECT admin_id FROM admin LIMIT 1)    AS a;

-- a confirmed booking whose slot has already started (inserted directly: the procedure refuses past slots)
CREATE TEMP SEQUENCE started_seq;
CREATE FUNCTION pg_temp.started_booking() RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_slot integer; v_req integer; v_b integer;
BEGIN
    v_req := pg_temp.mk_req(pg_temp.tv('c'));
    UPDATE service_request SET status = 'booked' WHERE request_id = v_req;
    v_slot := pg_temp.mk_slot(pg_temp.tv('w'), -(nextval('started_seq') * interval '3 hours'), interval '1 hour');
    PERFORM set_config('sm.booking_proc', 'on', true);
    UPDATE availability_slot SET status = 'reserved' WHERE slot_id = v_slot;
    PERFORM set_config('sm.booking_proc', 'off', true);
    INSERT INTO booking (request_id, worker_id, slot_id) VALUES (v_req, pg_temp.tv('w'), v_slot) RETURNING booking_id INTO v_b;
    INSERT INTO invoice (booking_id, amount) VALUES (v_b, 700);
    RETURN v_b;
END $$;

DO $$
DECLARE v_b integer; v_avg0 numeric; v_n0 integer; v_r integer;
BEGIN
    v_b := pg_temp.started_booking();
    -- T1 rating a confirmed booking is refused
    PERFORM pg_temp.expect_error(format('INSERT INTO rating (booking_id, score) VALUES (%s, 5)', v_b),
                                 'SM009', 'T1 rating a booking that is not completed -> RATING_NOT_ALLOWED');

    -- complete it through the procedure
    CALL sp_set_booking_outcome(v_b, pg_temp.tv('w'), 'completed');
    PERFORM pg_temp.ok((SELECT status FROM booking WHERE booking_id = v_b) = 'completed'
                       AND (SELECT r.status FROM service_request r JOIN booking b USING (request_id) WHERE b.booking_id = v_b) = 'closed',
                       'T2a worker completes a started booking, request closed');

    -- T2 rating updates the worker average and count
    SELECT avg_rating, rating_count INTO v_avg0, v_n0 FROM worker WHERE worker_id = pg_temp.tv('w');
    CALL sp_rate_booking(v_b, pg_temp.tv('c'), 1, 'test', v_r);
    PERFORM pg_temp.ok(
        (SELECT rating_count FROM worker WHERE worker_id = pg_temp.tv('w')) = v_n0 + 1
        AND (SELECT avg_rating FROM worker WHERE worker_id = pg_temp.tv('w'))
            = round((v_avg0 * v_n0 + 1) / (v_n0 + 1), 2),
        'T2b new rating recomputes avg_rating and rating_count (trigger)');
    PERFORM pg_temp.expect_error(format('CALL sp_rate_booking(%s, %s, 4, NULL, NULL)', v_b, pg_temp.tv('c')),
                                 'SM009', 'T2c a booking can be rated only once');
    DELETE FROM rating WHERE rating_id = v_r;
    PERFORM pg_temp.ok((SELECT rating_count FROM worker WHERE worker_id = pg_temp.tv('w')) = v_n0
                       AND (SELECT avg_rating FROM worker WHERE worker_id = pg_temp.tv('w')) = v_avg0,
                       'T2d deleting the rating restores the previous average');

    -- T3 status machine
    PERFORM pg_temp.expect_error(format('UPDATE booking SET status = ''confirmed'' WHERE booking_id = %s', v_b),
                                 'SM008', 'T3 completed -> confirmed is rejected by the status guard');
END $$;

-- T4 no-show opens exactly one system dispute; outcome before the start is refused
DO $$
DECLARE v_b integer; v_future integer;
BEGIN
    v_b := pg_temp.started_booking();
    CALL sp_set_booking_outcome(v_b, pg_temp.tv('w'), 'no_show');
    PERFORM pg_temp.ok((SELECT count(*) FROM dispute WHERE booking_id = v_b AND raised_by_role = 'system' AND status = 'open') = 1,
                       'T4a marking no-show auto-creates one open system dispute');

    v_future := pg_temp.book(pg_temp.tv('c'), pg_temp.mk_req(pg_temp.tv('c')), pg_temp.tv('w'),
                             pg_temp.mk_slot(pg_temp.tv('w'), interval '2 days'));
    PERFORM pg_temp.expect_error(format('CALL sp_set_booking_outcome(%s, %s, ''completed'')', v_future, pg_temp.tv('w')),
                                 'SM014', 'T4b cannot complete a job before it starts -> TOO_EARLY');
    PERFORM pg_temp.expect_error(format('CALL sp_set_booking_outcome(%s, %s, ''completed'')', v_future, pg_temp.tv('w') + 1),
                                 'SM011', 'T4c another worker cannot report the outcome -> FORBIDDEN');

    -- T5 a reserved slot cannot be deleted or reopened by hand
    PERFORM pg_temp.expect_error(format('DELETE FROM availability_slot WHERE slot_id = (SELECT slot_id FROM booking WHERE booking_id = %s)', v_future),
                                 'SM013', 'T5a deleting a booked slot -> SLOT_NOT_EDITABLE');
    PERFORM pg_temp.expect_error(format('UPDATE availability_slot SET status = ''open'' WHERE slot_id = (SELECT slot_id FROM booking WHERE booking_id = %s)', v_future),
                                 'SM013', 'T5b re-opening a booked slot by hand -> SLOT_NOT_EDITABLE');
END $$;

-- O1/O2 overlap constraint
DO $$
DECLARE v_s integer;
BEGIN
    v_s := pg_temp.mk_slot(pg_temp.tv('w'), interval '9 days', interval '2 hours');
    PERFORM pg_temp.expect_error(format(
        'INSERT INTO availability_slot (worker_id, start_time, end_time) SELECT worker_id, start_time + interval ''1 hour'', end_time + interval ''1 hour'' FROM availability_slot WHERE slot_id = %s', v_s),
        '23P01', 'O1 overlapping slot for the same worker -> exclusion constraint');
    INSERT INTO availability_slot (worker_id, start_time, end_time)
    SELECT worker_id, end_time, end_time + interval '1 hour' FROM availability_slot WHERE slot_id = v_s;
    PERFORM pg_temp.ok(true, 'O2 back-to-back slot (end = next start) is allowed');
END $$;

-- D1-D3 disputes with refunds
DO $$
DECLARE v_b integer; v_i integer; v_p integer; v_d integer;
BEGIN
    CALL sp_create_booking(pg_temp.tv('c'), pg_temp.mk_req(pg_temp.tv('c')), pg_temp.tv('w'),
                           pg_temp.mk_slot(pg_temp.tv('w'), interval '12 days'), v_b, v_i);
    CALL sp_pay_invoice(v_i, pg_temp.tv('c'), 'card', v_p);
    CALL sp_raise_dispute(v_b, 'customer', pg_temp.tv('c'), 'Overcharged', v_d);
    PERFORM pg_temp.expect_error(format('CALL sp_resolve_dispute(%s, %s, ''resolved'', ''x'', 999999)', v_d, pg_temp.tv('a')),
                                 'SM015', 'D1 refund larger than the payment -> INVALID_REFUND');
    CALL sp_resolve_dispute(v_d, pg_temp.tv('a'), 'resolved', 'Partial refund agreed', 100);
    PERFORM pg_temp.ok((SELECT refund_amount FROM payment WHERE payment_id = v_p) = 100
                       AND (SELECT status FROM payment WHERE payment_id = v_p) = 'partially_refunded'
                       AND (SELECT status FROM dispute WHERE dispute_id = v_d) = 'resolved',
                       'D2 resolving with a refund updates payment, invoice and dispute');
    PERFORM pg_temp.expect_error(format('CALL sp_resolve_dispute(%s, %s, ''rejected'', NULL, 0)', v_d, pg_temp.tv('a')),
                                 'SM010', 'D3 a resolved dispute cannot be resolved again -> DISPUTE_NOT_OPEN');
END $$;

-- V1 leaderboard: only verified workers, ranks per category
SELECT pg_temp.ok(
    NOT EXISTS (SELECT 1 FROM v_worker_leaderboard l JOIN worker w USING (worker_id) WHERE w.verification_status <> 'verified')
    AND (SELECT count(DISTINCT category_id) FROM v_worker_leaderboard WHERE rank_in_category = 1) = 8,
    'V1 leaderboard lists only verified workers and has a #1 in every category');

-- V2 Bayesian smoothing: one 5-star rating scores below many 4.6 ratings
SELECT pg_temp.ok(fn_bayesian_rating(5, 1) < fn_bayesian_rating(4.6, 40),
                  'V2 fn_bayesian_rating: 1 x 5.0 ranks below 40 x 4.6');

-- R1 admin review: pending -> verified
DO $$
BEGIN
    CALL sp_review_worker(pg_temp.wid('rekha.nair@example.com'), pg_temp.tv('a'), 'verified');
    PERFORM pg_temp.ok((SELECT verification_status FROM worker WHERE email = 'rekha.nair@example.com') = 'verified'
                       AND (SELECT verified_by FROM worker WHERE email = 'rekha.nair@example.com') IS NOT NULL,
                       'R1 admin verification sets status and reviewer');
END $$;

ROLLBACK;
