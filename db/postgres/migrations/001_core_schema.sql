-- ============================================================================
-- 001_core_schema.sql  -  PostgreSQL relational core (ACID side of the system)
-- Owner: Person A.  Shared baseline: after the Day-1 freeze, any change needs a
-- line in docs/CHANGELOG.md and a heads-up to Person B.
--
-- Conventions: snake_case, integer identity PKs, timestamptz everywhere,
-- CHECK constraints instead of ENUM types (cheaper to evolve).
-- Deviations from the ER diagram are tagged "ER-CHANGE n" and explained in
-- docs/04-decisions-and-er-changes.md.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;   -- needed for the slot-overlap exclusion constraint

-- ---------------------------------------------------------------- people ----
CREATE TABLE admin (
    admin_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL,
    email       text        NOT NULL UNIQUE
);

CREATE TABLE customer (
    customer_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text        NOT NULL,
    email       text        NOT NULL UNIQUE,
    phone       text,
    locality    text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker (
    worker_id           integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name                text          NOT NULL,
    email               text          NOT NULL UNIQUE,
    phone               text,
    locality            text          NOT NULL,
    bio                 text,
    hourly_rate         numeric(10,2) NOT NULL CHECK (hourly_rate >= 0),          -- ER-CHANGE 1 (price source for invoices)
    verification_status text          NOT NULL DEFAULT 'pending'
                        CHECK (verification_status IN ('pending','verified','rejected')),
    verified_by         integer       REFERENCES admin(admin_id),
    avg_rating          numeric(3,2),                                              -- trigger-maintained; NULL = no ratings yet (ER-CHANGE 7)
    rating_count        integer       NOT NULL DEFAULT 0,                          -- trigger-maintained
    created_at          timestamptz   NOT NULL DEFAULT now(),
    -- pending <=> nobody has reviewed yet (ER-CHANGE 8)
    CONSTRAINT ck_worker_review CHECK ((verification_status = 'pending') = (verified_by IS NULL))
);

-- ------------------------------------------------------------- catalogue ----
CREATE TABLE service_category (
    category_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        text NOT NULL UNIQUE
);

CREATE TABLE worker_category (
    worker_id   integer NOT NULL REFERENCES worker(worker_id)           ON DELETE CASCADE,
    category_id integer NOT NULL REFERENCES service_category(category_id) ON DELETE CASCADE,
    PRIMARY KEY (worker_id, category_id)
);

-- ---------------------------------------------------------- availability ----
CREATE TABLE availability_slot (
    slot_id     integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_id   integer     NOT NULL REFERENCES worker(worker_id) ON DELETE CASCADE,
    start_time  timestamptz NOT NULL,
    end_time    timestamptz NOT NULL,
    status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','reserved','blocked')),
    CONSTRAINT ck_slot_range CHECK (end_time > start_time),
    -- needed so booking can reference (slot_id, worker_id) and prove the slot belongs to that worker
    CONSTRAINT uq_slot_worker UNIQUE (slot_id, worker_id),
    -- a worker can never have two overlapping slots (ER-CHANGE 4)
    CONSTRAINT ex_slot_no_overlap EXCLUDE USING gist (
        worker_id WITH =,
        tstzrange(start_time, end_time) WITH &&
    )
);

-- ------------------------------------------------------------- requests -----
CREATE TABLE service_request (
    request_id  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    customer_id integer     NOT NULL REFERENCES customer(customer_id),
    description text        NOT NULL CHECK (length(btrim(description)) > 0),
    status      text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','closed','cancelled')),
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------- bookings -----
CREATE TABLE booking (
    booking_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    request_id   integer     NOT NULL REFERENCES service_request(request_id),
    worker_id    integer     NOT NULL REFERENCES worker(worker_id),
    slot_id      integer     NOT NULL,
    status       text        NOT NULL DEFAULT 'confirmed'
                 CHECK (status IN ('confirmed','completed','cancelled','no_show')),
    created_at   timestamptz NOT NULL DEFAULT now(),
    cancelled_at timestamptz,
    -- the slot must belong to the booked worker
    CONSTRAINT fk_booking_slot_worker FOREIGN KEY (slot_id, worker_id)
        REFERENCES availability_slot (slot_id, worker_id),
    CONSTRAINT ck_booking_cancelled CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);

-- "one booking per slot" - but a CANCELLED booking must free its slot (ER-CHANGE 2)
CREATE UNIQUE INDEX ux_booking_active_slot    ON booking (slot_id)    WHERE status <> 'cancelled';
-- one live booking per request (ER-CHANGE 3)
CREATE UNIQUE INDEX ux_booking_active_request ON booking (request_id) WHERE status = 'confirmed';

CREATE TABLE invoice (
    invoice_id  integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id  integer       NOT NULL UNIQUE REFERENCES booking(booking_id),
    amount      numeric(10,2) NOT NULL CHECK (amount >= 0),
    status      text          NOT NULL DEFAULT 'issued'
                CHECK (status IN ('issued','paid','void','refunded','partially_refunded')),
    issued_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE TABLE payment (
    payment_id    integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id    integer       NOT NULL REFERENCES invoice(invoice_id),
    amount        numeric(10,2) NOT NULL CHECK (amount > 0),
    method        text          NOT NULL CHECK (method IN ('upi','card','netbanking','cash')),
    status        text          NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','success','failed','refunded','partially_refunded')),
    refund_amount numeric(10,2) NOT NULL DEFAULT 0 CHECK (refund_amount >= 0),
    paid_at       timestamptz,
    CONSTRAINT ck_payment_refund CHECK (refund_amount <= amount)
);

CREATE TABLE rating (
    rating_id   integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id  integer     NOT NULL UNIQUE REFERENCES booking(booking_id),
    score       smallint    NOT NULL CHECK (score BETWEEN 1 AND 5),
    comment     text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dispute (
    dispute_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    booking_id      integer     NOT NULL REFERENCES booking(booking_id),
    resolved_by     integer     REFERENCES admin(admin_id),
    raised_by_role  text        NOT NULL CHECK (raised_by_role IN ('customer','worker','system')),  -- ER-CHANGE 6
    reason          text        NOT NULL,
    status          text        NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','rejected')),
    resolution_note text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_dispute_resolver CHECK ((status = 'open') = (resolved_by IS NULL))
);

-- ---------------------------------------------------------------- indexes ---
-- (the two partial unique indexes on booking and the GiST exclusion index above are also indexes)
-- Availability lookups: "open future slots of worker X" - the hottest query in the system
CREATE INDEX ix_slot_worker_open_start ON availability_slot (worker_id, start_time) WHERE status = 'open';
CREATE INDEX ix_slot_start_open        ON availability_slot (start_time)            WHERE status = 'open';
CREATE INDEX ix_request_customer       ON service_request (customer_id, created_at DESC);
CREATE INDEX ix_request_status         ON service_request (status);
CREATE INDEX ix_booking_worker_status  ON booking (worker_id, status);
CREATE INDEX ix_booking_request        ON booking (request_id);
CREATE INDEX ix_worker_category_cat    ON worker_category (category_id);
CREATE INDEX ix_worker_status_locality ON worker (verification_status, locality);
CREATE INDEX ix_payment_invoice        ON payment (invoice_id);
CREATE INDEX ix_dispute_status         ON dispute (status);
