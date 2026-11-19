-- Test helpers, created as temporary functions (pg_temp) so they vanish with the session.
-- Loaded by scripts/run-sql-tests.ts before each test file.

-- Run a statement and assert that it fails with the given SQLSTATE.
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_code text, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    BEGIN
        EXECUTE p_sql;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = p_code THEN
            RAISE NOTICE 'PASS %', p_label;
            RETURN;
        END IF;
        RAISE EXCEPTION 'FAIL %: expected SQLSTATE %, got % (%)', p_label, p_code, SQLSTATE, SQLERRM;
    END;
    RAISE EXCEPTION 'FAIL %: expected SQLSTATE % but the statement succeeded', p_label, p_code;
END $$;

CREATE FUNCTION pg_temp.ok(p_cond boolean, p_label text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    IF p_cond IS NOT TRUE THEN
        RAISE EXCEPTION 'FAIL %', p_label;
    END IF;
    RAISE NOTICE 'PASS %', p_label;
END $$;

CREATE FUNCTION pg_temp.wid(p_email text) RETURNS integer LANGUAGE sql AS
$$ SELECT worker_id FROM worker WHERE email = p_email $$;

CREATE FUNCTION pg_temp.cid(p_email text) RETURNS integer LANGUAGE sql AS
$$ SELECT customer_id FROM customer WHERE email = p_email $$;

-- A fresh slot for a worker starting p_offset from now (clears that worker's overlapping OPEN slots first).
CREATE FUNCTION pg_temp.mk_slot(p_worker integer, p_offset interval, p_len interval DEFAULT interval '2 hours')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v_id integer; v_start timestamptz := now() + p_offset;
BEGIN
    DELETE FROM availability_slot
    WHERE worker_id = p_worker AND status = 'open'
      AND tstzrange(start_time, end_time) && tstzrange(v_start, v_start + p_len);
    INSERT INTO availability_slot (worker_id, start_time, end_time) VALUES (p_worker, v_start, v_start + p_len)
    RETURNING slot_id INTO v_id;
    RETURN v_id;
END $$;

CREATE FUNCTION pg_temp.mk_req(p_customer integer, p_text text DEFAULT 'test request') RETURNS integer
LANGUAGE sql AS $$
    INSERT INTO service_request (customer_id, description) VALUES (p_customer, p_text) RETURNING request_id
$$;

-- Book through the real procedure; returns the booking id.
CREATE FUNCTION pg_temp.book(p_customer integer, p_request integer, p_worker integer, p_slot integer) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE v_b integer; v_i integer;
BEGIN
    CALL sp_create_booking(p_customer, p_request, p_worker, p_slot, v_b, v_i);
    RETURN v_b;
END $$;

-- Unit vector along axis a (optionally mixed with axis b), 384 dims.
CREATE FUNCTION pg_temp.unit(a integer, b integer DEFAULT NULL, wb double precision DEFAULT 0.5)
RETURNS vector LANGUAGE sql AS $$
    SELECT (array_agg(CASE WHEN g = a THEN 1.0 WHEN g = b THEN wb ELSE 0.0 END ORDER BY g))::real[]::vector
    FROM generate_series(1, 384) g
$$;

-- Read one column of the per-file temp table t (CALL arguments cannot contain subqueries).
CREATE FUNCTION pg_temp.tv(p_col text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE v integer;
BEGIN
    EXECUTE format('SELECT %I FROM t', p_col) INTO v;
    RETURN v;
END $$;
