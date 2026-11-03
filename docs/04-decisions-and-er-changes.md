# 04 - Decisions, ER changes and open questions

Read this together on Day 0. Everything in section 1 is **already implemented** in `db/postgres/migrations/001_core_schema.sql`.
Section 2 lists interpretations of the synopsis that you should confirm (with each other and, ideally, your guide) before building on them.

## 1. Changes to the ER diagram (update the diagram before submission)

| # | Change | Why | Where |
|---|--------|-----|-------|
| 1 | `WORKER.hourly_rate numeric(10,2)` added | The ER has no price anywhere, so an invoice amount had no source. Invoice = `hourly_rate x slot hours`. | 001 |
| 2 | `BOOKING.slot_id` is unique **only for non-cancelled bookings** (partial unique index) instead of a plain UK | A plain UK means a cancelled booking blocks its slot forever, so the slot could never be re-offered. The partial index still guarantees "one live booking per slot". | 001 `ux_booking_active_slot` |
| 3 | Composite FK `booking(slot_id, worker_id) -> availability_slot(slot_id, worker_id)` | Makes it impossible to book worker X into worker Y's slot, at the schema level. | 001 |
| 4 | Exclusion constraint on `availability_slot` (no overlapping ranges per worker) | A worker cannot be in two places at once; enforced by the DB, not by the UI. Needs `btree_gist`. | 001 `ex_slot_no_overlap` |
| 5 | One live (`confirmed`) booking per request (partial unique index) | A request maps to one job; prevents duplicate confirmed bookings for the same request. | 001 `ux_booking_active_request` |
| 6 | `DISPUTE.raised_by_role` also allows `'system'` | The no-show trigger raises disputes automatically. | 001 |
| 7 | `WORKER.avg_rating` is `NULL` when there are no ratings | `0` would look like "terrible". Ranking handles NULL via the Bayesian formula. | 001 |
| 8 | `CHECK (verification_status = 'pending') = (verified_by IS NULL)` | Status and reviewer can never disagree. Same idea on `dispute.resolved_by`. | 001 |
| 9 | All timestamps are `timestamptz` (ER says `timestamp`) | Correct across time zones; the UI renders in Asia/Kolkata. | 001 |
| 10 | `INVOICE.status` and `PAYMENT.status` get extra values for partial refunds | Cancellation refund tiers (100/50/0%) need `partially_refunded`. | 001 |

Cardinalities assumed from the diagram: Customer 1-N ServiceRequest; ServiceRequest 1-N Booking (but only one live at a time, see #5); Worker 1-N AvailabilitySlot; Booking 1-1 Invoice; Invoice 1-N Payment (retries, refunds); Booking 1-0..1 Rating; Booking 1-N Dispute; Worker M-N ServiceCategory.

## 2. Interpretations to confirm

| # | Question | Default we built for | Alternative (cost if you switch later) |
|---|----------|----------------------|-----------------------------------------|
| D1 | The synopsis says workers "view/accept matched jobs", but the booking must atomically reserve + invoice. Does a worker have to accept? | **No: booking is instantly `confirmed`.** "Matched jobs" = (a) the worker's confirmed bookings, plus (b) a read-only list of open requests that semantically match the worker's skills (reverse matching). | Add a `pending` booking status and an accept step. Touches the procedure, the status-guard trigger and 3 screens: roughly +1 day for Person A. |
| D2 | The ER has no password/credential columns. How do users sign in? | **Demo identity picker**: choose a seeded customer/worker/admin, get a signed session cookie. Roles are enforced server-side. No passwords. | Add `password_hash` columns + bcrypt + NextAuth credentials: ~1 day, mostly boilerplate. Say in the report that auth is out of scope. |
| D3 | Payments | **Simulated gateway**: `sp_pay_invoice` marks the payment successful. No real PSP. | Razorpay/Stripe test mode: extra 1-2 days, adds webhooks. Not needed for a DBMS project. |
| D4 | Embedding model | **`Xenova/all-MiniLM-L6-v2`, 384 dims, run locally in Node** (free, offline, fast enough). Hidden behind `embed(text)`. | Hosted embedding API (check its dimension, change `vector(384)`, re-embed). `multilingual-e5-small` is also 384-dim and helps with Hinglish queries. |
| D5 | Ranking formula | `final = 0.7 x similarity + 0.3 x (bayesian_rating / 5)`; Bayesian prior mean 3.5, weight 5; similarity threshold 0.25. All three are env/params, tuned using the eval set. | Pure similarity, or learn-to-rank (overkill). |
| D6 | Cancellation / refund policy | Customer cancels **>= 24 h** before start: 100% refund. **2-24 h**: 50%. **< 2 h**: 0%. Worker cancels: always 100%. Admin can override via a dispute. | Any thresholds; they are constants in one procedure. |
| D7 | Location | Locality is a **text equality filter** (optional) - no geo/PostGIS. | PostGIS distance: out of scope. |
| D8 | Where do portfolio photos live? | Files on local disk under `web/public/uploads/<worker_id>/`; MongoDB stores only the URL + caption. | GridFS or S3: swap the upload handler, schema unchanged. |
| D9 | No cross-database transactions | **PostgreSQL is the source of truth** for whether a worker exists. Write order: PG commit -> Mongo upsert -> embedding upsert. A `reconcile` script repairs partial failures. Say this explicitly in the report. | Outbox pattern - overkill here. |

## 3. Explicitly out of scope

Real authentication, real payments, geo-search, chat/notifications, mobile app, multi-city, worker payouts, image moderation.
If time remains, the stretch items (in each person's backlog) are: DB-level roles/GRANTs, Hinglish queries, reverse matching UI polish.

## 4. How to change a frozen decision

1. Write the change in `docs/CHANGELOG.md` (what, why, who is affected).
2. Tell the other person before merging.
3. Update the affected doc/section in the same PR.
