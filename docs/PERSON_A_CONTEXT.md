# PERSON A - Transactional Core (context document)

> **How to use:** read once fully, then keep open. If you use an AI assistant, paste this file plus `docs/02-architecture.md` and `docs/03-api-contract.md` at the start of each session and say "I am Person A".
> Person B's counterpart is `PERSON_B_CONTEXT.md`. You do not need to read it, only section 4 of this file (the handshake).

## 1. The project in 60 seconds
A web marketplace for local skilled workers (electricians, plumbers, tutors, maids, appliance repair). A customer types a problem in plain language; the system finds relevant, available, verified workers by *meaning* (embeddings), ranks them by similarity + rating, and lets the customer book a time slot. Booking must be atomic: check availability, reserve the slot, create the invoice, no double-booking, no partial writes.
Three databases, each chosen for its data shape: **PostgreSQL** (transactions), **pgvector** (semantic search, inside PostgreSQL), **MongoDB** (variable worker portfolios). The course project is about showing *why* each, and about using advanced DB features properly.

## 2. Your mission
You own everything that must be **correct under concurrency and failure**: the relational schema's behaviour, the stored procedures, triggers, views, indexes, and the app code and screens around bookings, money, ratings, disputes and admin. If a bug in your area could lose money or double-book a worker, the database (not the UI) must stop it.

**Done means:** all acceptance tests AT-08 .. AT-19 in `05-test-and-demo-plan.md` pass; every procedure/trigger/view has a test; index evidence is captured; Admin, Worker-jobs and Customer-booking screens work end to end.

## 3. What you own

| Area | Files / objects |
|---|---|
| Migrations | `001_core_schema.sql` (given, you own changes), `003_*` .. `099_*` |
| SQL objects | `fn_bayesian_rating`, `sp_create_booking`, `sp_cancel_booking`, `sp_pay_invoice`, `sp_resolve_dispute`, triggers T1-T4, views `v_worker_leaderboard`, `v_platform_kpis` |
| API | `/api/dev/*`, `/api/me`, `/api/workers/:id/slots`, `/api/workers/me/slots*`, `/api/bookings*`, `/api/invoices/*`, `/api/admin/*`, `/api/leaderboard` |
| Libs | `web/src/lib/db/pg.ts`, `session.ts`, `errors.ts`, `nav.ts` |
| Screens | customer: slot confirm + booking summary, My bookings, Pay, Rate, Raise dispute - worker: Jobs - admin: Worker verification, Disputes, Analytics, Leaderboard |
| Scripts | `scripts/test-concurrency.ts`, `scripts/bench-slots.ts`, `db/postgres/tests/A_*` |

Do **not** edit: `002_vector.sql`, `100+` migrations, `lib/embeddings`, `lib/matching`, `lib/db/mongo.ts`, `db/mongo/*`, `/api/requests*`, `/api/workers` (profile/portfolio), worker profile/portfolio/availability pages. Those are Person B's. Ask via `CHANGELOG.md` or message.

## 4. Handshake with Person B

**You give B** (deadlines in `03-api-contract.md`): `lib/db/pg.ts` + `withTx`, `lib/session.ts`, `lib/errors.ts` (end Day 2); `GET /api/workers/:id/slots` and `fn_bayesian_rating` (end Week 1); `POST /api/bookings` (end Week 2); rating + leaderboard (end Week 3).
**You get from B:** `GET /api/categories` (Week 1); `GET /api/requests/:id/matches` returning real rows (Week 2) - until then build the booking UI from a hard-coded `MatchesResponse` copied from the contract; worker profile/portfolio endpoints (Week 3) for the admin verification screen.
**Shared:** `db/postgres/seed/*`. If you need more seed data, add a *new* file `seed/010_*.sql`; do not rewrite 001/002.

## 5. Day-1 checklist
1. `cp .env.example .env && docker compose up -d --wait && ./scripts/db-reset.sh`
2. Open `psql` (`docker compose exec postgres psql -U skillmarket skillmarket`) and read the schema: `\d+ booking`, `\d+ availability_slot`. Find the partial unique indexes and the exclusion constraint. Try to double-book by hand with two `psql` sessions - see which constraint fires.
3. Scaffold the app: `npx create-next-app@latest web` (TypeScript, App Router, `src/` dir, Tailwind), `cd web && npm i pg` and `npm i -D @types/pg`. Copy `contracts/types.ts` to `web/src/lib/contracts.ts`.
4. Write `lib/db/pg.ts`:
```ts
import { Pool, PoolClient } from 'pg';
export const pool = new Pool({ connectionString: process.env.POSTGRES_URL });
export async function withTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
```
5. Write `lib/errors.ts` with `mapPgError(e)` using the SQLSTATE table in `03-api-contract.md`, and an `apiHandler(fn)` wrapper that turns thrown errors into `{ error: { code, message } }` responses. Push both and tell Person B (they need them).

## 6. Detailed specs

### 6.1 `sp_create_booking(p_customer_id, p_request_id, p_worker_id, p_slot_id, INOUT p_booking_id)`
Language `plpgsql`, `CREATE PROCEDURE`. The caller wraps it in a transaction (the procedure must not `COMMIT`).
```
1. SELECT worker_id, status, start_time, end_time FROM availability_slot
     WHERE slot_id = p_slot_id FOR UPDATE;                      -- LOCK ORDER: slot first
   not found            -> NOT_FOUND-ish (raise SM001 SLOT_TAKEN is fine for "no such open slot")
   worker_id <> p_worker_id -> SM005
   status <> 'open'         -> SM001 SLOT_TAKEN
   start_time <= now()      -> SM002
2. worker must be verified   -> SM004
3. SELECT customer_id, status FROM service_request WHERE request_id = p_request_id FOR UPDATE;   -- then request
   customer_id <> p_customer_id -> SM011 ;  status <> 'open' -> SM003
4. INSERT booking (status 'confirmed') RETURNING booking_id
5. UPDATE availability_slot SET status = 'reserved'
6. UPDATE service_request   SET status = 'booked'
7. amount := round(hourly_rate * extract(epoch FROM (end_time - start_time)) / 3600, 2)
   INSERT invoice (booking_id, amount, 'issued')
8. p_booking_id := new id
```
Why it is correct: the row lock serialises concurrent attempts on the same slot; the loser blocks, then sees `reserved` and raises `SLOT_TAKEN`. The partial unique index is the backstop. Any exception aborts the caller's transaction, so no partial writes.
Be ready to explain: why `FOR UPDATE` and not `SERIALIZABLE`; what a deadlock would look like and how consistent lock order avoids it.

### 6.2 `sp_cancel_booking(p_booking_id, p_actor_role, p_actor_id, p_reason, INOUT p_refund_amount, INOUT p_policy)`
Lock booking, then its slot, then request. Preconditions: booking `confirmed` and slot `start_time > now()` else `SM006`; actor must be the booking's customer (via request) or its worker, else raise forbidden-style error.

| Actor | Hours until start | Refund of paid amount | `p_policy` |
|---|---|---|---|
| customer | >= 24 | 100% | `full` |
| customer | >= 2 and < 24 | 50% | `partial` |
| customer | < 2 | 0% | `none` |
| worker | any | 100% | `full` |

Effects: booking -> `cancelled` + `cancelled_at = now()`; slot -> `open` if customer cancelled, `blocked` if worker cancelled; request -> `open`; invoice: if no successful payment -> `void` (refund 0), else compute refund `r`, set `payment.refund_amount = r`, payment status `refunded` (r = amount) / `partially_refunded` (0 < r < amount) / unchanged (r = 0), invoice status `refunded` / `partially_refunded` / `paid`. Return refund amount and policy. Keep the thresholds as named constants at the top of the procedure.

### 6.3 `sp_pay_invoice(p_invoice_id, p_customer_id, p_method, INOUT p_payment_id)`
Lock invoice; check the invoice belongs to the customer (via booking -> request) and is `issued` else `SM007`; insert payment (`success`, `paid_at = now()`, amount = invoice amount); invoice -> `paid`. Simulated gateway: always succeeds (optionally let `method = 'card'` with a magic test value fail to demo `failed` payments).

### 6.4 `sp_resolve_dispute(p_dispute_id, p_admin_id, p_status, p_note, p_refund)`
Lock dispute; must be `open` else `SM010`; set status (`resolved`/`rejected`), `resolved_by`, `resolution_note`. If `p_refund > 0`: only allowed on a paid invoice and `p_refund <= amount - already refunded`; update payment/invoice refund fields like 6.2.

### 6.5 Triggers
| ID | Trigger | Rule |
|---|---|---|
| T1 | `trg_rating_biu` BEFORE INSERT on `rating` | booking must be `completed` else `SM009` |
| T2 | `trg_rating_aiud` AFTER INSERT/UPDATE OF score/DELETE on `rating` | recompute `worker.avg_rating` (round 2) and `rating_count` for the booking's worker; avg is NULL when count = 0 |
| T3 | `trg_booking_noshow` AFTER UPDATE OF status on `booking` WHEN `NEW.status='no_show' AND OLD.status <> 'no_show'` | insert `dispute(booking_id, raised_by_role='system', reason='Auto-flagged: customer no-show', status='open')` |
| T4 | `trg_booking_status_guard` BEFORE UPDATE OF status on `booking` | allowed transitions only: `confirmed -> completed | cancelled | no_show`; everything else `SM008` |

`fn_bayesian_rating(avg, n) = (n * coalesce(avg,0) + 5 * 3.5) / (n + 5)` (make prior mean and weight default parameters). Person B uses it in matching, so ship it first (migration `003`).

### 6.6 Views
- `v_worker_leaderboard`: verified workers only; columns as `LeaderboardRow`; `bayesian_score = fn_bayesian_rating(...)`; `completed_jobs` = count of `completed` bookings; `rank_in_category = RANK() OVER (PARTITION BY category_id ORDER BY bayesian_score DESC, rating_count DESC)`.
- `v_platform_kpis`: totals by booking status, revenue (sum of paid minus refunded), average rating, no-show rate; plus a by-category and a by-day breakdown view (or one view with a `grouping` column) feeding `/api/admin/analytics`.

### 6.7 Indexes and evidence
Indexes already exist in 001. Your job is the *evidence*: `scripts/bench-slots.ts` inserts 100k-500k slots (e.g. 5k workers x many days, non-overlapping), then compares `EXPLAIN (ANALYZE, BUFFERS)` of "open future slots of worker X, next 5" with and without `ix_slot_worker_open_start` (drop it in the experiment, recreate after). Save outputs to `docs/evidence/`.

### 6.8 Slots API behaviour
Create is all-or-nothing in one transaction; overlap surfaces as `23P01` -> `SLOT_OVERLAP`. Patch/delete only when slot is `open` or `blocked` and belongs to the session worker (`WHERE worker_id = $session`), else `SLOT_NOT_EDITABLE`. Never trust `worker_id` from the body.

### 6.9 Security basics
Every handler: identify session, check role, and put ownership into the SQL (`WHERE ... AND customer_id = $1`) or into the procedure parameters. Use parameterised queries only. Never build SQL with string concatenation.

## 7. Backlog (priority, hours, target week)

| # | Task | P | Hours | Week |
|---|------|---|-------|------|
| A1 | Scaffold `web/`, `pg.ts`, `withTx`, `errors.ts` | P0 | 4 | 1 |
| A2 | Dev session/login, role guards, layout + nav | P0 | 4 | 1 |
| A3 | Migration 003: `fn_bayesian_rating`, T1, T2, T4 | P0 | 6 | 1 |
| A4 | Slots API (list/create/block/delete, overlap) | P0 | 3 | 1 |
| A5 | `sp_create_booking` + `POST /api/bookings` + SQL tests | P0 | 8 | 2 |
| A6 | `sp_cancel_booking` + refund tiers + API | P0 | 6 | 2 |
| A7 | `sp_pay_invoice` + payments API | P0 | 3 | 2 |
| A8 | complete / no-show endpoints + T3 | P0 | 3 | 3 |
| A9 | Rating + dispute APIs | P0 | 3 | 3 |
| A10 | Customer UI: confirm booking, My bookings, Pay, Rate, Dispute | P0 | 10 | 2-3 |
| A11 | Worker Jobs page (list, complete, no-show, cancel) | P0 | 4 | 3 |
| A12 | `sp_resolve_dispute` + admin APIs (verify, disputes) | P0 | 5 | 3 |
| A13 | Admin UI: verification queue, disputes, analytics | P1 | 8 | 3-4 |
| A14 | Views (leaderboard, KPIs) + leaderboard page | P1 | 5 | 4 |
| A15 | Concurrency + rollback + trigger test scripts (AT-08..AT-15) | P0 | 6 | 4 |
| A16 | Slot-lookup index benchmark + evidence | P1 | 3 | 4 |
| A17 | *Stretch:* DB roles (`app_customer/worker/admin`), GRANTs, optionally RLS | P2 | 4 | 5 |
| | **Core total (A1-A16)** | | **81** | |

Suggested order within a week: SQL first, API second, UI last - the SQL is the graded part and the UI is thin.

## 8. How to test as you go
`psql` scripts in `db/postgres/tests/A_*.sql` using `BEGIN; ... ROLLBACK;` so they are repeatable. For concurrency use two `psql` windows first (open `BEGIN; CALL ...;` in window 1 without committing, run the same in window 2, watch it block, then commit window 1), then automate in `test-concurrency.ts`. Full list: `05-test-and-demo-plan.md`.

## 9. Pitfalls
- Calling `COMMIT` inside the procedure, or forgetting the caller must hold the transaction (`withTx`).
- Locking the request before the slot somewhere else in the code: breaks the lock order, risks deadlock.
- Using `NOW()` vs `clock_timestamp()` in tests: `now()` is frozen for the whole transaction.
- Returning prices as strings: `numeric` comes back from `pg` as a string; convert with `Number()` in the DTO layer.
- Forgetting that a cancelled booking keeps its row: queries for "current booking of a slot" must filter `status <> 'cancelled'`.
- Letting the trigger recompute average with an integer division: cast to `numeric`.
- Editing 001 after Person B has seeded: announce it, reset DBs, add a CHANGELOG line.

## 10. Questions you should be able to answer in the viva
1. What exactly happens, step by step, when two customers click "Book" on the same slot within the same millisecond? Which mechanism decides the winner?
2. Why a row lock *and* a unique index? What does each catch?
3. Why must the booking, slot update and invoice be in one transaction? Show what breaks if the invoice insert fails.
4. Why can a cancelled booking not hold the plain unique key on `slot_id`? What did we change?
5. How does the Bayesian average stop a single 5-star rating from dominating? What are the prior mean and weight and why those values?
6. Explain the exclusion constraint and why `btree_gist` is needed.
7. What is the difference between a stored procedure and a function in PostgreSQL, and why `CALL` with `INOUT`?
8. How do triggers keep `avg_rating` correct on insert, update and delete? What if two ratings arrive concurrently?
9. What does `EXPLAIN ANALYZE` show for the slot query with and without the partial index?
10. Which isolation level did you use and why is `READ COMMITTED` enough here?

## 11. Working agreements
Branch `a/<task>`, small PRs, Person B reviews. Never rewrite an applied migration after Day 1 without a CHANGELOG entry and a DB reset announcement. Save evidence (outputs, screenshots) in `docs/evidence/` the moment you produce it.
