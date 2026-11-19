-- ============================================================================
-- 003_functions_triggers.sql  -  helper functions and triggers
--
-- Custom error codes raised by this project (SQLSTATE class "SM"); the app maps
-- them to API error codes in src/lib/errors.ts:
--   SM001 SLOT_TAKEN               SM006 BOOKING_NOT_CANCELLABLE   SM011 FORBIDDEN
--   SM002 SLOT_IN_PAST             SM007 INVOICE_NOT_PAYABLE       SM012 NOT_FOUND
--   SM003 REQUEST_NOT_OPEN         SM008 INVALID_STATUS_TRANSITION SM013 SLOT_NOT_EDITABLE
--   SM004 WORKER_NOT_VERIFIED      SM009 RATING_NOT_ALLOWED        SM014 TOO_EARLY
--   SM005 SLOT_WORKER_MISMATCH     SM010 DISPUTE_NOT_OPEN          SM015 INVALID_REFUND
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Bayesian (smoothed) rating: pulls workers with few ratings towards a prior.
-- One 5-star rating => (1*5 + 5*3.5)/(1+5) = 3.75, not 5.0.
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_bayesian_rating(
    p_avg          numeric,
    p_count        integer,
    p_prior_mean   numeric DEFAULT 3.5,
    p_prior_weight numeric DEFAULT 5
) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
    SELECT round((coalesce(p_count, 0) * coalesce(p_avg, 0) + p_prior_weight * p_prior_mean)
                 / (coalesce(p_count, 0) + p_prior_weight), 3)
$$;

-- ---------------------------------------------------------------------------
-- T1  A rating is only allowed for a COMPLETED booking.
-- ---------------------------------------------------------------------------
CREATE FUNCTION trg_rating_check_booking() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_status text;
BEGIN
    SELECT status INTO v_status FROM booking WHERE booking_id = NEW.booking_id;
    IF v_status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION 'Only completed bookings can be rated (booking % is %)', NEW.booking_id, coalesce(v_status, 'missing')
            USING ERRCODE = 'SM009';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_rating_biu
    BEFORE INSERT OR UPDATE OF booking_id ON rating
    FOR EACH ROW EXECUTE FUNCTION trg_rating_check_booking();

-- ---------------------------------------------------------------------------
-- T2  Keep worker.avg_rating / rating_count correct on INSERT, UPDATE, DELETE.
-- The worker row is locked first, so two ratings arriving at the same time for
-- the same worker are applied one after the other (no lost update).
-- ---------------------------------------------------------------------------
CREATE FUNCTION fn_recompute_worker_rating(p_worker_id integer) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM 1 FROM worker WHERE worker_id = p_worker_id FOR UPDATE;
    UPDATE worker w
    SET avg_rating   = s.avg_score,
        rating_count = s.cnt
    FROM (
        SELECT round(avg(r.score)::numeric, 2) AS avg_score, count(*)::int AS cnt
        FROM rating r JOIN booking b ON b.booking_id = r.booking_id
        WHERE b.worker_id = p_worker_id
    ) s
    WHERE w.worker_id = p_worker_id;            -- avg(...) over zero rows is NULL => "no ratings yet"
END $$;

CREATE FUNCTION trg_rating_recompute() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE v_old integer; v_new integer;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT worker_id INTO v_old FROM booking WHERE booking_id = OLD.booking_id;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT worker_id INTO v_new FROM booking WHERE booking_id = NEW.booking_id;
    END IF;
    IF v_old IS NOT NULL THEN PERFORM fn_recompute_worker_rating(v_old); END IF;
    IF v_new IS NOT NULL AND v_new IS DISTINCT FROM v_old THEN PERFORM fn_recompute_worker_rating(v_new); END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_rating_aiud
    AFTER INSERT OR UPDATE OF score, booking_id OR DELETE ON rating
    FOR EACH ROW EXECUTE FUNCTION trg_rating_recompute();

-- ---------------------------------------------------------------------------
-- T3  Booking status machine:  confirmed -> completed | cancelled | no_show.
-- Everything else (e.g. completed -> confirmed) is rejected by the database.
-- ---------------------------------------------------------------------------
CREATE FUNCTION trg_booking_status_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;
    IF OLD.status = 'confirmed' AND NEW.status IN ('completed', 'cancelled', 'no_show') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'Booking % cannot go from % to %', OLD.booking_id, OLD.status, NEW.status
        USING ERRCODE = 'SM008';
END $$;

CREATE TRIGGER trg_booking_status_guard
    BEFORE UPDATE OF status ON booking
    FOR EACH ROW EXECUTE FUNCTION trg_booking_status_guard();

-- ---------------------------------------------------------------------------
-- T4  A no-show automatically opens a dispute for an admin to review.
-- ---------------------------------------------------------------------------
CREATE FUNCTION trg_booking_flag_noshow() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM dispute WHERE booking_id = NEW.booking_id AND raised_by_role = 'system' AND status = 'open') THEN
        INSERT INTO dispute (booking_id, raised_by_role, reason)
        VALUES (NEW.booking_id, 'system', 'Auto-flagged: booking marked as no-show by the worker');
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER trg_booking_noshow
    AFTER UPDATE OF status ON booking
    FOR EACH ROW
    WHEN (NEW.status = 'no_show' AND OLD.status IS DISTINCT FROM 'no_show')
    EXECUTE FUNCTION trg_booking_flag_noshow();

-- ---------------------------------------------------------------------------
-- T5  A reserved slot cannot be deleted, moved or re-opened by hand;
--     only the booking procedures change it.
-- ---------------------------------------------------------------------------
CREATE FUNCTION trg_slot_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF current_setting('sm.booking_proc', true) = 'on' THEN   -- set locally by the booking procedures
        RETURN coalesce(NEW, OLD);
    END IF;
    IF TG_OP = 'DELETE' AND OLD.status = 'reserved' THEN
        RAISE EXCEPTION 'Slot % is booked and cannot be deleted', OLD.slot_id USING ERRCODE = 'SM013';
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.status = 'reserved' THEN
        RAISE EXCEPTION 'Slot % is booked and cannot be changed', OLD.slot_id USING ERRCODE = 'SM013';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.status = 'reserved' THEN
        RAISE EXCEPTION 'Slots are reserved only by booking a slot' USING ERRCODE = 'SM013';
    END IF;
    RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER trg_slot_guard
    BEFORE UPDATE OR DELETE ON availability_slot
    FOR EACH ROW EXECUTE FUNCTION trg_slot_guard();
