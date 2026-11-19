-- ============================================================================
-- 004_procedures.sql  -  stored procedures for every state-changing business action
--
-- Every procedure runs inside the CALLER's transaction and never COMMITs: either
-- every statement in it takes effect, or (on any error) none does.
-- Lock order everywhere: booking -> slot -> request -> invoice -> payment.
-- Call from SQL:      CALL sp_create_booking(1, 7, 6, 133, NULL, NULL);
-- Call from node-pg:  client.query('CALL sp_create_booking($1,$2,$3,$4,NULL,NULL)', [...]) -> rows[0]
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Book a slot: lock the slot, validate, insert booking, reserve slot, mark the
-- request booked, issue the invoice (rate x hours). All or nothing.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_create_booking(
    p_customer_id integer,
    p_request_id  integer,
    p_worker_id   integer,
    p_slot_id     integer,
    INOUT p_booking_id integer,
    INOUT p_invoice_id integer
) LANGUAGE plpgsql AS $$
DECLARE
    v_slot    availability_slot%ROWTYPE;
    v_req     service_request%ROWTYPE;
    v_worker  worker%ROWTYPE;
    v_amount  numeric(10,2);
BEGIN
    PERFORM set_config('sm.booking_proc', 'on', true);

    -- 1. lock the slot row: concurrent bookings of the same slot queue up here
    SELECT * INTO v_slot FROM availability_slot WHERE slot_id = p_slot_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Slot % does not exist', p_slot_id USING ERRCODE = 'SM012';
    END IF;
    IF v_slot.worker_id <> p_worker_id THEN
        RAISE EXCEPTION 'Slot % does not belong to worker %', p_slot_id, p_worker_id USING ERRCODE = 'SM005';
    END IF;
    IF v_slot.status <> 'open' THEN
        RAISE EXCEPTION 'Slot % is no longer available', p_slot_id USING ERRCODE = 'SM001';
    END IF;
    IF v_slot.start_time <= now() THEN
        RAISE EXCEPTION 'Slot % has already started', p_slot_id USING ERRCODE = 'SM002';
    END IF;

    -- 2. the worker must be verified
    SELECT * INTO v_worker FROM worker WHERE worker_id = p_worker_id;
    IF v_worker.verification_status <> 'verified' THEN
        RAISE EXCEPTION 'Worker % is not verified', p_worker_id USING ERRCODE = 'SM004';
    END IF;

    -- 3. lock the request; it must be the caller's and still open
    SELECT * INTO v_req FROM service_request WHERE request_id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request % does not exist', p_request_id USING ERRCODE = 'SM012';
    END IF;
    IF v_req.customer_id <> p_customer_id THEN
        RAISE EXCEPTION 'Request % does not belong to this customer', p_request_id USING ERRCODE = 'SM011';
    END IF;
    IF v_req.status <> 'open' THEN
        RAISE EXCEPTION 'Request % is already %', p_request_id, v_req.status USING ERRCODE = 'SM003';
    END IF;

    -- 4-7. the writes
    INSERT INTO booking (request_id, worker_id, slot_id) VALUES (p_request_id, p_worker_id, p_slot_id)
    RETURNING booking_id INTO p_booking_id;

    UPDATE availability_slot SET status = 'reserved' WHERE slot_id = p_slot_id;
    UPDATE service_request   SET status = 'booked'   WHERE request_id = p_request_id;

    v_amount := round(v_worker.hourly_rate * extract(epoch FROM (v_slot.end_time - v_slot.start_time)) / 3600, 2);
    INSERT INTO invoice (booking_id, amount) VALUES (p_booking_id, v_amount)
    RETURNING invoice_id INTO p_invoice_id;

    PERFORM set_config('sm.booking_proc', 'off', true);   -- re-arm the slot guard for the rest of the transaction
END $$;

-- ---------------------------------------------------------------------------
-- Cancel with refund policy.
--   customer cancels >= 24 h before start : 100 %      ('full')
--   customer cancels  2-24 h before start :  50 %      ('partial')
--   customer cancels  < 2 h before start  :   0 %      ('none')
--   worker or admin cancels               : 100 %      ('full')
-- Slot goes back to 'open' (customer/admin cancel) or 'blocked' (worker cancel);
-- the request is re-opened so the customer can book someone else.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_cancel_booking(
    p_booking_id  integer,
    p_actor_role  text,            -- 'customer' | 'worker' | 'admin'
    p_actor_id    integer,
    INOUT p_refund_amount numeric,
    INOUT p_policy        text
) LANGUAGE plpgsql AS $$
DECLARE
    c_full_hours    constant numeric := 24;
    c_partial_hours constant numeric := 2;
    c_partial_pct   constant numeric := 0.5;
    v_b       booking%ROWTYPE;
    v_slot    availability_slot%ROWTYPE;
    v_req     service_request%ROWTYPE;
    v_inv     invoice%ROWTYPE;
    v_pay     payment%ROWTYPE;
    v_hours   numeric;
    v_pct     numeric;
BEGIN
    PERFORM set_config('sm.booking_proc', 'on', true);

    SELECT * INTO v_b FROM booking WHERE booking_id = p_booking_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % does not exist', p_booking_id USING ERRCODE = 'SM012';
    END IF;
    SELECT * INTO v_slot FROM availability_slot WHERE slot_id = v_b.slot_id FOR UPDATE;
    SELECT * INTO v_req  FROM service_request   WHERE request_id = v_b.request_id FOR UPDATE;

    IF NOT (   (p_actor_role = 'customer' AND v_req.customer_id = p_actor_id)
            OR (p_actor_role = 'worker'   AND v_b.worker_id   = p_actor_id)
            OR (p_actor_role = 'admin'    AND EXISTS (SELECT 1 FROM admin WHERE admin_id = p_actor_id))) THEN
        RAISE EXCEPTION 'Not allowed to cancel booking %', p_booking_id USING ERRCODE = 'SM011';
    END IF;
    IF v_b.status <> 'confirmed' THEN
        RAISE EXCEPTION 'Booking % is % and cannot be cancelled', p_booking_id, v_b.status USING ERRCODE = 'SM006';
    END IF;
    IF v_slot.start_time <= now() THEN
        RAISE EXCEPTION 'Booking % has already started and cannot be cancelled', p_booking_id USING ERRCODE = 'SM006';
    END IF;

    v_hours := extract(epoch FROM (v_slot.start_time - now())) / 3600;
    IF p_actor_role <> 'customer' OR v_hours >= c_full_hours THEN
        v_pct := 1;           p_policy := 'full';
    ELSIF v_hours >= c_partial_hours THEN
        v_pct := c_partial_pct; p_policy := 'partial';
    ELSE
        v_pct := 0;           p_policy := 'none';
    END IF;

    UPDATE booking SET status = 'cancelled', cancelled_at = now(), cancelled_by = p_actor_role
    WHERE booking_id = p_booking_id;
    UPDATE availability_slot SET status = CASE WHEN p_actor_role = 'worker' THEN 'blocked' ELSE 'open' END
    WHERE slot_id = v_b.slot_id;
    UPDATE service_request SET status = 'open' WHERE request_id = v_b.request_id;

    -- money
    p_refund_amount := 0;
    SELECT * INTO v_inv FROM invoice WHERE booking_id = p_booking_id FOR UPDATE;
    IF FOUND THEN
        SELECT * INTO v_pay FROM payment WHERE invoice_id = v_inv.invoice_id AND status = 'success'
        ORDER BY payment_id DESC LIMIT 1 FOR UPDATE;
        IF NOT FOUND THEN
            UPDATE invoice SET status = 'void' WHERE invoice_id = v_inv.invoice_id;   -- nothing was paid
        ELSE
            p_refund_amount := round(v_pay.amount * v_pct, 2);
            IF p_refund_amount > 0 THEN
                UPDATE payment
                SET refund_amount = p_refund_amount,
                    status = CASE WHEN p_refund_amount = v_pay.amount THEN 'refunded' ELSE 'partially_refunded' END
                WHERE payment_id = v_pay.payment_id;
                UPDATE invoice
                SET status = CASE WHEN p_refund_amount = v_pay.amount THEN 'refunded' ELSE 'partially_refunded' END
                WHERE invoice_id = v_inv.invoice_id;
            END IF;                                                                  -- 0 % refund: invoice stays 'paid'
        END IF;
    END IF;

    PERFORM set_config('sm.booking_proc', 'off', true);   -- re-arm the slot guard
END $$;

-- ---------------------------------------------------------------------------
-- Pay an invoice (simulated gateway: always succeeds).
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_pay_invoice(
    p_invoice_id  integer,
    p_customer_id integer,
    p_method      text,
    INOUT p_payment_id integer
) LANGUAGE plpgsql AS $$
DECLARE
    v_inv   invoice%ROWTYPE;
    v_owner integer;
    v_bstat text;
BEGIN
    SELECT * INTO v_inv FROM invoice WHERE invoice_id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invoice % does not exist', p_invoice_id USING ERRCODE = 'SM012';
    END IF;
    SELECT r.customer_id, b.status INTO v_owner, v_bstat
    FROM booking b JOIN service_request r ON r.request_id = b.request_id
    WHERE b.booking_id = v_inv.booking_id;
    IF v_owner <> p_customer_id THEN
        RAISE EXCEPTION 'Invoice % does not belong to this customer', p_invoice_id USING ERRCODE = 'SM011';
    END IF;
    IF v_inv.status <> 'issued' OR v_bstat = 'cancelled' THEN
        RAISE EXCEPTION 'Invoice % is % and cannot be paid', p_invoice_id, v_inv.status USING ERRCODE = 'SM007';
    END IF;

    INSERT INTO payment (invoice_id, amount, method, status, paid_at)
    VALUES (p_invoice_id, v_inv.amount, p_method, 'success', now())
    RETURNING payment_id INTO p_payment_id;
    UPDATE invoice SET status = 'paid' WHERE invoice_id = p_invoice_id;
END $$;

-- ---------------------------------------------------------------------------
-- Worker reports the outcome of a job: 'completed' or 'no_show'.
-- Only possible once the slot has started. A no-show fires trigger T4.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_set_booking_outcome(
    p_booking_id integer,
    p_worker_id  integer,
    p_outcome    text
) LANGUAGE plpgsql AS $$
DECLARE
    v_b     booking%ROWTYPE;
    v_start timestamptz;
BEGIN
    IF p_outcome NOT IN ('completed', 'no_show') THEN
        RAISE EXCEPTION 'Outcome must be completed or no_show' USING ERRCODE = 'SM008';
    END IF;
    SELECT * INTO v_b FROM booking WHERE booking_id = p_booking_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Booking % does not exist', p_booking_id USING ERRCODE = 'SM012';
    END IF;
    IF v_b.worker_id <> p_worker_id THEN
        RAISE EXCEPTION 'Booking % is not your job', p_booking_id USING ERRCODE = 'SM011';
    END IF;
    SELECT start_time INTO v_start FROM availability_slot WHERE slot_id = v_b.slot_id;
    IF v_start > now() THEN
        RAISE EXCEPTION 'Booking % has not started yet', p_booking_id USING ERRCODE = 'SM014';
    END IF;

    UPDATE booking SET status = p_outcome WHERE booking_id = p_booking_id;   -- status guard (T3) checks the transition
    UPDATE service_request SET status = 'closed' WHERE request_id = v_b.request_id;
END $$;

-- ---------------------------------------------------------------------------
-- Customer rates a completed booking (trigger T1 checks the status, T2 updates the average).
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_rate_booking(
    p_booking_id  integer,
    p_customer_id integer,
    p_score       integer,
    p_comment     text,
    INOUT p_rating_id integer
) LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM booking b JOIN service_request r ON r.request_id = b.request_id
                   WHERE b.booking_id = p_booking_id AND r.customer_id = p_customer_id) THEN
        RAISE EXCEPTION 'Booking % is not yours', p_booking_id USING ERRCODE = 'SM011';
    END IF;
    IF EXISTS (SELECT 1 FROM rating WHERE booking_id = p_booking_id) THEN
        RAISE EXCEPTION 'Booking % is already rated', p_booking_id USING ERRCODE = 'SM009';
    END IF;
    INSERT INTO rating (booking_id, score, comment) VALUES (p_booking_id, p_score, nullif(btrim(p_comment), ''))
    RETURNING rating_id INTO p_rating_id;
END $$;

-- ---------------------------------------------------------------------------
-- Customer or worker raises a dispute on their own booking.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_raise_dispute(
    p_booking_id integer,
    p_role       text,
    p_actor_id   integer,
    p_reason     text,
    INOUT p_dispute_id integer
) LANGUAGE plpgsql AS $$
DECLARE v_ok boolean;
BEGIN
    SELECT (p_role = 'customer' AND r.customer_id = p_actor_id) OR (p_role = 'worker' AND b.worker_id = p_actor_id)
    INTO v_ok
    FROM booking b JOIN service_request r ON r.request_id = b.request_id
    WHERE b.booking_id = p_booking_id;
    IF v_ok IS NULL THEN
        RAISE EXCEPTION 'Booking % does not exist', p_booking_id USING ERRCODE = 'SM012';
    ELSIF NOT v_ok THEN
        RAISE EXCEPTION 'Booking % is not yours', p_booking_id USING ERRCODE = 'SM011';
    END IF;
    INSERT INTO dispute (booking_id, raised_by_role, reason) VALUES (p_booking_id, p_role, btrim(p_reason))
    RETURNING dispute_id INTO p_dispute_id;
END $$;

-- ---------------------------------------------------------------------------
-- Admin resolves or rejects a dispute, optionally refunding (part of) the payment.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_resolve_dispute(
    p_dispute_id integer,
    p_admin_id   integer,
    p_status     text,          -- 'resolved' | 'rejected'
    p_note       text,
    p_refund     numeric        -- 0 for none
) LANGUAGE plpgsql AS $$
DECLARE
    v_d    dispute%ROWTYPE;
    v_inv  invoice%ROWTYPE;
    v_pay  payment%ROWTYPE;
    v_new  numeric;
BEGIN
    IF p_status NOT IN ('resolved', 'rejected') THEN
        RAISE EXCEPTION 'Status must be resolved or rejected' USING ERRCODE = 'SM008';
    END IF;
    SELECT * INTO v_d FROM dispute WHERE dispute_id = p_dispute_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Dispute % does not exist', p_dispute_id USING ERRCODE = 'SM012';
    END IF;
    IF v_d.status <> 'open' THEN
        RAISE EXCEPTION 'Dispute % is already %', p_dispute_id, v_d.status USING ERRCODE = 'SM010';
    END IF;

    IF coalesce(p_refund, 0) > 0 THEN
        IF p_status <> 'resolved' THEN
            RAISE EXCEPTION 'A refund requires status resolved' USING ERRCODE = 'SM015';
        END IF;
        SELECT * INTO v_inv FROM invoice WHERE booking_id = v_d.booking_id FOR UPDATE;
        SELECT * INTO v_pay FROM payment
        WHERE invoice_id = v_inv.invoice_id AND status IN ('success', 'partially_refunded')
        ORDER BY payment_id DESC LIMIT 1 FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Nothing was paid for this booking, so nothing can be refunded' USING ERRCODE = 'SM015';
        END IF;
        v_new := v_pay.refund_amount + round(p_refund, 2);
        IF v_new > v_pay.amount THEN
            RAISE EXCEPTION 'Refund too large: at most % can still be refunded', v_pay.amount - v_pay.refund_amount
                USING ERRCODE = 'SM015';
        END IF;
        UPDATE payment SET refund_amount = v_new,
                           status = CASE WHEN v_new = amount THEN 'refunded' ELSE 'partially_refunded' END
        WHERE payment_id = v_pay.payment_id;
        UPDATE invoice SET status = CASE WHEN v_new = v_pay.amount THEN 'refunded' ELSE 'partially_refunded' END
        WHERE invoice_id = v_inv.invoice_id;
    END IF;

    UPDATE dispute
    SET status = p_status, resolved_by = p_admin_id, resolution_note = nullif(btrim(p_note), ''), resolved_at = now()
    WHERE dispute_id = p_dispute_id;
END $$;

-- ---------------------------------------------------------------------------
-- Admin verifies or rejects a worker profile.
-- ---------------------------------------------------------------------------
CREATE PROCEDURE sp_review_worker(
    p_worker_id integer,
    p_admin_id  integer,
    p_decision  text            -- 'verified' | 'rejected'
) LANGUAGE plpgsql AS $$
BEGIN
    IF p_decision NOT IN ('verified', 'rejected') THEN
        RAISE EXCEPTION 'Decision must be verified or rejected' USING ERRCODE = 'SM008';
    END IF;
    UPDATE worker SET verification_status = p_decision, verified_by = p_admin_id WHERE worker_id = p_worker_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Worker % does not exist', p_worker_id USING ERRCODE = 'SM012';
    END IF;
END $$;
