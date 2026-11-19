-- ============================================================================
-- seed/003_demo_state.sql  -  "live" data so every role has something to do right
-- after a reset. Times are relative to when you run the reset.
--
--   Aarav  (customer 1): open request "AC rattling"                -> search + book demo
--                        booking with Suresh that STARTED 1 h ago   -> worker completes, customer pays + rates
--   Diya   (customer 2): open request "dripping tap"
--                        PAID booking with Ravi in 3 days           -> cancel = 100 % refund
--   Neha   (customer 4): PAID booking with Irfan in ~10 h           -> cancel = 50 % refund
--   Karthik(customer 3): booking with Meena that STARTED 2 h ago    -> worker marks no-show -> auto dispute
--   Sanjay (customer 5): open dispute on a past job                 -> admin resolves with refund
--   + a few more open requests for the workers' "matching requests" list
-- ============================================================================

DO $$
DECLARE
    c_aarav   integer := (SELECT customer_id FROM customer WHERE email = 'aarav.patel@example.com');
    c_diya    integer := (SELECT customer_id FROM customer WHERE email = 'diya.reddy@example.com');
    c_karthik integer := (SELECT customer_id FROM customer WHERE email = 'karthik.s@example.com');
    c_neha    integer := (SELECT customer_id FROM customer WHERE email = 'neha.gupta@example.com');
    c_sanjay  integer := (SELECT customer_id FROM customer WHERE email = 'sanjay.hegde@example.com');
    c_fatima  integer := (SELECT customer_id FROM customer WHERE email = 'fatima.sheikh@example.com');
    w_suresh  integer := (SELECT worker_id FROM worker WHERE email = 'suresh.babu@example.com');
    w_ravi    integer := (SELECT worker_id FROM worker WHERE email = 'ravi.kumar@example.com');
    w_irfan   integer := (SELECT worker_id FROM worker WHERE email = 'irfan.m@example.com');
    w_meena   integer := (SELECT worker_id FROM worker WHERE email = 'meena.iyer@example.com');
    v_req     integer;
    v_slot    integer;
    v_book    integer;
    v_inv     integer;
    v_pay     integer;
    v_start   timestamptz;
BEGIN
    -- ---- open requests (embedded by the reset script) --------------------------
    INSERT INTO service_request (customer_id, description, created_at) VALUES
      (c_aarav,  'My AC is making a loud rattling noise and the room is not getting cold', now() - interval '20 minutes'),
      (c_diya,   'Kitchen tap keeps dripping all night and the sink drains very slowly',   now() - interval '3 hours'),
      (c_karthik,'Looking for someone to help my daughter with class 10 algebra and trigonometry', now() - interval '1 day'),
      (c_neha,   'Seeing cockroaches inside the kitchen cabinets every night',           now() - interval '5 hours'),
      (c_fatima, 'Wardrobe door has come off its hinge and will not close',             now() - interval '2 hours'),
      (c_sanjay, 'Damp patch spreading on the bedroom wall, paint is peeling',           now() - interval '6 hours');

    -- ---- Aarav + Suresh: job in progress (started 1 hour ago), invoice unpaid --
    v_start := date_trunc('hour', now()) - interval '1 hour';
    INSERT INTO service_request (customer_id, description, status, created_at)
    VALUES (c_aarav, 'Ceiling fan in the bedroom wobbles and makes a humming sound', 'booked', now() - interval '2 days')
    RETURNING request_id INTO v_req;
    INSERT INTO availability_slot (worker_id, start_time, end_time, status)
    VALUES (w_suresh, v_start, v_start + interval '2 hours', 'reserved') RETURNING slot_id INTO v_slot;
    INSERT INTO booking (request_id, worker_id, slot_id, created_at) VALUES (v_req, w_suresh, v_slot, now() - interval '2 days')
    RETURNING booking_id INTO v_book;
    INSERT INTO invoice (booking_id, amount) SELECT v_book, round(hourly_rate * 2, 2) FROM worker WHERE worker_id = w_suresh;

    -- ---- Karthik + Meena: tutoring session that started 2 hours ago ------------
    v_start := date_trunc('hour', now()) - interval '2 hours';
    INSERT INTO service_request (customer_id, description, status, created_at)
    VALUES (c_karthik, 'Physics doubt-clearing session before the unit test', 'booked', now() - interval '3 days')
    RETURNING request_id INTO v_req;
    INSERT INTO availability_slot (worker_id, start_time, end_time, status)
    VALUES (w_meena, v_start, v_start + interval '1 hour', 'reserved') RETURNING slot_id INTO v_slot;
    INSERT INTO booking (request_id, worker_id, slot_id, created_at) VALUES (v_req, w_meena, v_slot, now() - interval '3 days')
    RETURNING booking_id INTO v_book;
    INSERT INTO invoice (booking_id, amount) SELECT v_book, round(hourly_rate * 1, 2) FROM worker WHERE worker_id = w_meena;

    -- ---- Diya + Ravi: paid booking ~3 days ahead (through the real procedures) -
    INSERT INTO service_request (customer_id, description, created_at)
    VALUES (c_diya, 'Switchboard in the hall sparks when I plug in the iron', now() - interval '1 day')
    RETURNING request_id INTO v_req;
    SELECT slot_id INTO v_slot FROM availability_slot
    WHERE worker_id = w_ravi AND status = 'open' AND start_time > now() + interval '60 hours'
    ORDER BY start_time LIMIT 1;
    CALL sp_create_booking(c_diya, v_req, w_ravi, v_slot, v_book, v_inv);
    CALL sp_pay_invoice(v_inv, c_diya, 'upi', v_pay);

    -- ---- Neha + Irfan: paid booking ~10 hours ahead (cancelling now = 50 %) -----
    v_start := date_trunc('hour', now()) + interval '10 hours';
    DELETE FROM availability_slot                                -- make room in Irfan's calendar
    WHERE worker_id = w_irfan AND status = 'open'
      AND tstzrange(start_time, end_time) && tstzrange(v_start, v_start + interval '2 hours');
    INSERT INTO availability_slot (worker_id, start_time, end_time)
    VALUES (w_irfan, v_start, v_start + interval '2 hours') RETURNING slot_id INTO v_slot;
    INSERT INTO service_request (customer_id, description, created_at)
    VALUES (c_neha, 'Water pressure in the shower is very low since last week', now() - interval '4 hours')
    RETURNING request_id INTO v_req;
    CALL sp_create_booking(c_neha, v_req, w_irfan, v_slot, v_book, v_inv);
    CALL sp_pay_invoice(v_inv, c_neha, 'card', v_pay);

    -- ---- Sanjay: open dispute on one of his past completed jobs ----------------
    SELECT b.booking_id INTO v_book
    FROM booking b JOIN service_request r ON r.request_id = b.request_id
    WHERE r.customer_id = c_sanjay AND b.status = 'completed'
    ORDER BY b.booking_id LIMIT 1;
    CALL sp_raise_dispute(v_book, 'customer', c_sanjay, 'The worker left without cleaning up and the problem came back two days later.', v_pay);
END $$;
