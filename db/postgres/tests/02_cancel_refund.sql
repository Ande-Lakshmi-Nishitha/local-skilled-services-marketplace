-- Cancellation procedure: refund tiers, slot / request / invoice effects, rebooking.
BEGIN;

CREATE TEMP TABLE t AS
SELECT pg_temp.wid('joseph.dsouza@example.com') AS w,
       pg_temp.wid('venkatesh.p@example.com')   AS w2,
       pg_temp.cid('karthik.s@example.com')     AS c1,
       pg_temp.cid('neha.gupta@example.com')    AS c2;

-- book + pay a slot starting p_offset from now, return booking id
CREATE FUNCTION pg_temp.paid_booking(p_offset interval, p_worker integer DEFAULT NULL) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_b integer; v_i integer; v_p integer; v_w integer := coalesce(p_worker, pg_temp.tv('w'));
BEGIN
    CALL sp_create_booking(pg_temp.tv('c1'), pg_temp.mk_req(pg_temp.tv('c1')), v_w,
                           pg_temp.mk_slot(v_w, p_offset), v_b, v_i);
    CALL sp_pay_invoice(v_i, pg_temp.tv('c1'), 'upi', v_p);
    RETURN v_b;
END $$;

CREATE FUNCTION pg_temp.cancel(p_b integer, p_role text, p_actor integer, OUT refund numeric, OUT policy text)
LANGUAGE plpgsql AS $$
BEGIN
    CALL sp_cancel_booking(p_b, p_role, p_actor, refund, policy);
END $$;

DO $$
DECLARE v_b integer; v_inv integer; r record; v_paid numeric;
BEGIN
    -- C1 customer, 30 h before: full refund
    v_b := pg_temp.paid_booking(interval '30 hours');
    SELECT amount INTO v_paid FROM invoice WHERE booking_id = v_b;
    SELECT * INTO r FROM pg_temp.cancel(v_b, 'customer', pg_temp.tv('c1'));
    PERFORM pg_temp.ok(r.policy = 'full' AND r.refund = v_paid
        AND (SELECT status FROM invoice WHERE booking_id = v_b) = 'refunded'
        AND (SELECT s.status FROM availability_slot s JOIN booking b USING (slot_id) WHERE b.booking_id = v_b) = 'open'
        AND (SELECT sr.status FROM service_request sr JOIN booking b USING (request_id) WHERE b.booking_id = v_b) = 'open',
        'C1 customer cancels 30 h ahead -> 100 % refund, slot and request re-opened');

    -- C2 customer, 5 h before: 50 %
    v_b := pg_temp.paid_booking(interval '5 hours');
    SELECT amount INTO v_paid FROM invoice WHERE booking_id = v_b;
    SELECT * INTO r FROM pg_temp.cancel(v_b, 'customer', pg_temp.tv('c1'));
    PERFORM pg_temp.ok(r.policy = 'partial' AND r.refund = round(v_paid / 2, 2)
        AND (SELECT status FROM invoice WHERE booking_id = v_b) = 'partially_refunded',
        'C2 customer cancels 5 h ahead -> 50 % refund');

    -- C3 customer, 1 h before: nothing back
    v_b := pg_temp.paid_booking(interval '1 hour');
    SELECT * INTO r FROM pg_temp.cancel(v_b, 'customer', pg_temp.tv('c1'));
    PERFORM pg_temp.ok(r.policy = 'none' AND r.refund = 0
        AND (SELECT status FROM invoice WHERE booking_id = v_b) = 'paid',
        'C3 customer cancels 1 h ahead -> 0 % refund, invoice stays paid');

    -- C4 worker cancels 1 h before: still full refund, slot blocked
    v_b := pg_temp.paid_booking(interval '70 minutes', pg_temp.tv('w2'));
    SELECT amount INTO v_paid FROM invoice WHERE booking_id = v_b;
    SELECT * INTO r FROM pg_temp.cancel(v_b, 'worker', pg_temp.tv('w2'));
    PERFORM pg_temp.ok(r.policy = 'full' AND r.refund = v_paid
        AND (SELECT s.status FROM availability_slot s JOIN booking b USING (slot_id) WHERE b.booking_id = v_b) = 'blocked',
        'C4 worker cancels -> always 100 % refund, slot becomes blocked');

    -- C5 unpaid booking -> invoice void
    CALL sp_create_booking(pg_temp.tv('c1'), pg_temp.mk_req(pg_temp.tv('c1')), pg_temp.tv('w'),
                           pg_temp.mk_slot(pg_temp.tv('w'), interval '50 hours'), v_b, v_inv);
    SELECT * INTO r FROM pg_temp.cancel(v_b, 'customer', pg_temp.tv('c1'));
    PERFORM pg_temp.ok(r.refund = 0 AND (SELECT status FROM invoice WHERE booking_id = v_b) = 'void',
        'C5 cancelling an unpaid booking voids the invoice');

    -- C6 cannot cancel twice, cannot cancel someone else''s booking
    PERFORM pg_temp.expect_error(format('CALL sp_cancel_booking(%s, ''customer'', %s, NULL, NULL)', v_b, pg_temp.tv('c1')),
                                 'SM006', 'C6a cancelling a cancelled booking -> BOOKING_NOT_CANCELLABLE');
    v_b := pg_temp.paid_booking(interval '80 hours');
    PERFORM pg_temp.expect_error(format('CALL sp_cancel_booking(%s, ''customer'', %s, NULL, NULL)', v_b, pg_temp.tv('c2')),
                                 'SM011', 'C6b another customer cannot cancel -> FORBIDDEN');
END $$;

-- C7 the slot freed by a cancellation can be booked again by someone else
DO $$
DECLARE v_b integer; v_slot integer; v_b2 integer;
BEGIN
    v_b := pg_temp.paid_booking(interval '100 hours');
    SELECT slot_id INTO v_slot FROM booking WHERE booking_id = v_b;
    PERFORM pg_temp.cancel(v_b, 'customer', pg_temp.tv('c1'));
    v_b2 := pg_temp.book(pg_temp.tv('c2'), pg_temp.mk_req(pg_temp.tv('c2')), pg_temp.tv('w'), v_slot);
    PERFORM pg_temp.ok(v_b2 IS NOT NULL AND v_b2 <> v_b, 'C7 a cancelled slot can be rebooked (partial unique index)');
END $$;

ROLLBACK;
