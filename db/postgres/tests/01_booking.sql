-- Booking transaction tests: atomic booking, every rejection path, rollback, unique-index backstop.
-- Runs inside a transaction that is rolled back: the database is unchanged afterwards.
BEGIN;

UPDATE worker SET verification_status = 'pending', verified_by = NULL WHERE email = 'arjun.menon@example.com';  -- state this test needs (rolled back)

CREATE TEMP TABLE t AS
SELECT pg_temp.wid('anil.sharma@example.com')   AS anil,
       pg_temp.wid('irfan.m@example.com')       AS irfan,
       pg_temp.wid('arjun.menon@example.com')   AS pending_worker,
       pg_temp.cid('aarav.patel@example.com')   AS c1,
       pg_temp.cid('diya.reddy@example.com')    AS c2;

-- B1 happy path ---------------------------------------------------------------
DO $$
DECLARE v_slot integer; v_req integer; v_b integer; v_amount numeric; v_rate numeric;
BEGIN
    v_slot := pg_temp.mk_slot(pg_temp.tv('anil'), interval '3 days', interval '90 minutes');
    v_req  := pg_temp.mk_req(pg_temp.tv('c1'));
    v_b    := pg_temp.book(pg_temp.tv('c1'), v_req, pg_temp.tv('anil'), v_slot);
    SELECT hourly_rate INTO v_rate FROM worker WHERE worker_id = pg_temp.tv('anil');
    SELECT amount INTO v_amount FROM invoice WHERE booking_id = v_b;
    PERFORM pg_temp.ok(
        (SELECT status FROM booking WHERE booking_id = v_b) = 'confirmed'
        AND (SELECT status FROM availability_slot WHERE slot_id = v_slot) = 'reserved'
        AND (SELECT status FROM service_request WHERE request_id = v_req) = 'booked'
        AND v_amount = round(v_rate * 1.5, 2),
        'B1 booking creates booking + reserves slot + books request + invoice of rate x 1.5 h');
    CREATE TEMP TABLE b1 AS SELECT v_slot AS slot_id, v_req AS request_id, v_b AS booking_id;
END $$;

-- B2 the same slot cannot be booked twice -------------------------------------
SELECT pg_temp.expect_error(format('CALL sp_create_booking(%s, %s, %s, %s, NULL, NULL)',
       pg_temp.tv('c2'), pg_temp.mk_req(pg_temp.tv('c2')), pg_temp.tv('anil'), (SELECT slot_id FROM b1)),
       'SM001', 'B2 second booking of a reserved slot -> SLOT_TAKEN');

-- B3 slot of another worker ---------------------------------------------------
SELECT pg_temp.expect_error(format('CALL sp_create_booking(%s, %s, %s, %s, NULL, NULL)',
       pg_temp.tv('c2'), pg_temp.mk_req(pg_temp.tv('c2')), pg_temp.tv('irfan'),
       pg_temp.mk_slot(pg_temp.tv('anil'), interval '4 days')),
       'SM005', 'B3 slot does not belong to the chosen worker -> SLOT_WORKER_MISMATCH');

-- B4 slot already started -----------------------------------------------------
SELECT pg_temp.expect_error(format('CALL sp_create_booking(%s, %s, %s, %s, NULL, NULL)',
       pg_temp.tv('c2'), pg_temp.mk_req(pg_temp.tv('c2')), pg_temp.tv('anil'),
       pg_temp.mk_slot(pg_temp.tv('anil'), interval '-30 minutes')),
       'SM002', 'B4 slot in the past -> SLOT_IN_PAST');

-- B5 unverified worker --------------------------------------------------------
SELECT pg_temp.expect_error(format('CALL sp_create_booking(%s, %s, %s, %s, NULL, NULL)',
       pg_temp.tv('c2'), pg_temp.mk_req(pg_temp.tv('c2')), pg_temp.tv('pending_worker'),
       pg_temp.mk_slot(pg_temp.tv('pending_worker'), interval '2 days')),
       'SM004', 'B5 pending worker cannot be booked -> WORKER_NOT_VERIFIED');

-- B6 request of another customer / request not open ---------------------------
SELECT pg_temp.expect_error(format('CALL sp_create_booking(%s, %s, %s, %s, NULL, NULL)',
       pg_temp.tv('c2'), pg_temp.mk_req(pg_temp.tv('c1')), pg_temp.tv('anil'),
       pg_temp.mk_slot(pg_temp.tv('anil'), interval '5 days')),
       'SM011', 'B6a booking someone else''s request -> FORBIDDEN');
SELECT pg_temp.expect_error(format('CALL sp_create_booking(%s, %s, %s, %s, NULL, NULL)',
       pg_temp.tv('c1'), (SELECT request_id FROM b1), pg_temp.tv('anil'),
       pg_temp.mk_slot(pg_temp.tv('anil'), interval '6 days')),
       'SM003', 'B6b request that is already booked -> REQUEST_NOT_OPEN');

-- B7 atomicity: make the LAST step (invoice insert) fail and check nothing remains
CREATE FUNCTION pg_temp.fail_invoice() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'forced failure for the rollback test' USING ERRCODE = 'P0001'; END $$;
CREATE TRIGGER zz_test_fail_invoice BEFORE INSERT ON invoice FOR EACH ROW EXECUTE FUNCTION pg_temp.fail_invoice();
DO $$
DECLARE v_slot integer; v_req integer; v_before integer;
BEGIN
    v_slot := pg_temp.mk_slot(pg_temp.tv('irfan'), interval '3 days');
    v_req  := pg_temp.mk_req(pg_temp.tv('c2'));
    SELECT count(*) INTO v_before FROM booking;
    BEGIN
        PERFORM pg_temp.book(pg_temp.tv('c2'), v_req, pg_temp.tv('irfan'), v_slot);
        RAISE EXCEPTION 'FAIL B7: booking should have failed';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'FAIL%' THEN RAISE; END IF;
    END;
    PERFORM pg_temp.ok(
        (SELECT count(*) FROM booking) = v_before
        AND (SELECT status FROM availability_slot WHERE slot_id = v_slot) = 'open'
        AND (SELECT status FROM service_request WHERE request_id = v_req) = 'open',
        'B7 failure in the last step rolls back the booking, the slot and the request (atomicity)');
END $$;
DROP TRIGGER zz_test_fail_invoice ON invoice;

-- B8 the partial unique index stops a second live booking even without the procedure
SELECT pg_temp.expect_error(format('INSERT INTO booking (request_id, worker_id, slot_id) VALUES (%s, %s, %s)',
       pg_temp.mk_req(pg_temp.tv('c2')), pg_temp.tv('anil'), (SELECT slot_id FROM b1)),
       '23505', 'B8 unique index ux_booking_active_slot blocks a second live booking (backstop)');

-- B9 payment ------------------------------------------------------------------
DO $$
DECLARE v_inv integer; v_pay integer;
BEGIN
    SELECT invoice_id INTO v_inv FROM invoice WHERE booking_id = (SELECT booking_id FROM b1);
    CALL sp_pay_invoice(v_inv, pg_temp.tv('c1'), 'upi', v_pay);
    PERFORM pg_temp.ok((SELECT status FROM invoice WHERE invoice_id = v_inv) = 'paid'
                       AND (SELECT status FROM payment WHERE payment_id = v_pay) = 'success',
                       'B9a paying marks invoice paid and records a successful payment');
    PERFORM pg_temp.expect_error(format('CALL sp_pay_invoice(%s, %s, ''upi'', NULL)', v_inv, pg_temp.tv('c1')),
                                 'SM007', 'B9b paying twice -> INVOICE_NOT_PAYABLE');
    PERFORM pg_temp.expect_error(format('CALL sp_pay_invoice(%s, %s, ''upi'', NULL)', v_inv, pg_temp.tv('c2')),
                                 'SM011', 'B9c paying another customer''s invoice -> FORBIDDEN');
END $$;

ROLLBACK;
