# 05 - Acceptance tests and demo script

Run all tests from a clean `./scripts/db-reset.sh`. "Owner" = who writes and runs it; the other person reviews.

## 1. Acceptance tests

| ID | Owner | Given / When / Then |
|---|---|---|
| AT-01 | B | **Semantic match beats keyword.** Given seeded + embedded workers, when a customer posts "fan not spinning", then an electrician is in the top 3 even though worker 1's text never contains "fan". Same for "AC not cooling, rattling noise" -> Deepak Joshi (worker 6) ranks first. |
| AT-02 | B | **Unverified excluded.** Workers 10 and 13 (pending) never appear in matches, whatever the query. |
| AT-03 | B | **Availability required.** A verified worker with no open future slot does not appear; blocking all of a worker's slots removes them from results. |
| AT-04 | B | **Ranking uses trust.** Two workers with equal similarity: the one with more/better ratings ranks higher; a worker with a single 5-star rating does not outrank one with 20 ratings at 4.7. |
| AT-05 | B | **HNSW is used.** `EXPLAIN` of the ANN stage shows `Index Scan using ix_worker_embedding_hnsw`. |
| AT-06 | B | **Schema flexibility.** Four trades render four different portfolio shapes on the profile page with no schema change; adding a new trade (e.g. "Gardener" with `plants_handled[]`) needs only data. |
| AT-07 | B | **Partial failure is repairable.** Delete a worker's Mongo document and embeddings manually; `scripts/reconcile.ts` detects and restores them. |
| AT-08 | A | **No double booking under concurrency.** 20 parallel `POST /api/bookings` for the same slot (different customers/requests) -> exactly 1 returns 201, 19 return `SLOT_TAKEN`; DB has exactly 1 non-cancelled booking, 1 invoice, slot `reserved`. Repeat 20 times. |
| AT-09 | A | **Atomic rollback.** With a test-only trigger that makes the invoice insert fail (see section 2), `sp_create_booking` leaves *no* booking, slot still `open`, request still `open`. |
| AT-10 | A | **Backstop works.** With the row lock temporarily removed from the procedure, the partial unique index still stops the second booking (shows layered defence). |
| AT-11 | A | **Refund tiers.** Customer cancels 30 h before start -> refund 100%, 5 h before -> 50%, 1 h before -> 0%; worker cancels -> 100% and slot becomes `blocked`; customer cancel -> slot back to `open` and request back to `open`; unpaid invoice becomes `void`. |
| AT-12 | A | **Rebooking after cancel.** The freed slot can be booked again by another customer. |
| AT-13 | A | **Rating trigger.** Completing then rating a booking updates `worker.avg_rating` and `rating_count`; rating a `confirmed` booking fails with `RATING_NOT_ALLOWED`; one rating per booking. |
| AT-14 | A | **No-show trigger.** Marking `no_show` creates exactly one `open` dispute with `raised_by_role='system'`; calling it twice does not create a second one. |
| AT-15 | A | **Status guard.** `completed -> confirmed` and `cancelled -> completed` are rejected by the DB. |
| AT-16 | A | **Overlap rejected.** Creating an overlapping slot for the same worker returns `SLOT_OVERLAP`; adjacent slots (end = next start) are allowed. |
| AT-17 | A | **Admin.** Verifying a pending worker makes them appear in matching (after B embeds them); resolving a dispute with refund updates payment + invoice. |
| AT-18 | A | **Leaderboard.** `v_worker_leaderboard` ranks per category using the Bayesian score; unverified workers absent. |
| AT-19 | both | **Authorisation.** Customer A cannot read/book/cancel customer B's request or booking; worker cannot call admin routes (403). |
| AT-20 | both | **Clean clone.** Fresh clone -> `docker compose up -d --wait` -> `db-reset.sh` -> `npm run build && npm start` -> demo flow works. |

## 2. Test fixtures worth knowing
- **Forced failure inside a procedure** (AT-09): in the test only, create a trigger on `invoice` that does `IF current_setting('sm.fail_invoice', true) = '1' THEN RAISE EXCEPTION 'forced'; END IF;`, then `SET sm.fail_invoice = '1'` in the test session before `CALL sp_create_booking(...)`.
- **Concurrency harness** (AT-08): a Node script that opens N `pg` connections and fires `CALL sp_create_booking(...)` at the same instant (`Promise.all` after a barrier), then asserts counts with a separate connection. Also run it through the HTTP API once.
- **Time travel for refund tests** (AT-11): create the slot at `now() + interval '30 hours'` etc. directly in the test setup; do not wait.

## 3. Demo script (about 8 minutes, rehearse twice)

| Min | Presenter | Step | What it proves |
|---|---|---|---|
| 0:00 | both | One slide: problem + 3 stores and why. | Architecture driven by data shape |
| 0:45 | B | As a customer type "AC not cooling, rattling noise". Show ranked results; point at similarity vs trust score. Run the keyword baseline on the same text: no hits. | Semantic search; vocabulary mismatch |
| 2:00 | B | Open top worker profile: portfolio from MongoDB. Open a tutor and a maid: different shapes. | NoSQL flexibility |
| 2:45 | A | Book the first slot -> invoice appears -> pay (UPI). Show the DB rows: booking, slot reserved, invoice, payment. | Atomic booking |
| 3:45 | A | Run the 20-client concurrency script live: 1 success, 19 `SLOT_TAKEN`. | No double booking |
| 4:30 | A | Cancel with < 24 h: 50% refund; slot reopens. | Procedure + refund logic |
| 5:15 | A | Worker marks complete; customer rates 5 stars; show worker average change (trigger). Mark another booking no-show; dispute appears. Admin resolves it. | Triggers, roles |
| 6:15 | A | Leaderboard view; `EXPLAIN ANALYZE` of slot lookup showing partial index. | Views, indexing |
| 6:45 | B | Evaluation table (semantic vs keyword) and HNSW benchmark graph. | Evidence, not claims |
| 7:30 | both | New worker registers -> pending -> admin verifies -> appears in search for a fitting query (shows the three stores staying in sync; mention reconcile). | End-to-end |
| 8:00 | both | Questions. Each is ready for the viva questions in their context doc. | |

## 4. Report outline (suggested)
1. Problem and objectives - 2. Architecture and why three stores - 3. ER diagram (updated) and normalisation notes - 4. Advanced features (one subsection each, with SQL + evidence) - 5. Matching design and evaluation - 6. Concurrency and integrity design - 7. Limitations (filters after ANN, no cross-DB transactions, simulated payments/auth) - 8. Future work.
