# Changes to the submitted ER diagram, and design decisions

## Schema changes (update the ER diagram in the report)

| # | Change | Why |
|---|---|---|
| 1 | `WORKER.hourly_rate` added | the ER had no price anywhere, so an invoice had no amount. Invoice = rate x slot hours |
| 2 | `BOOKING.slot_id` unique **only while the booking is not cancelled** (partial unique index) | a plain unique key would block a cancelled slot forever |
| 3 | composite FK `booking(slot_id, worker_id) -> availability_slot(slot_id, worker_id)` | a booking can never point at another worker's slot |
| 4 | exclusion constraint: no overlapping slots per worker | a worker cannot be in two places at once |
| 5 | one confirmed booking per request (partial unique index) | a request is one job |
| 6 | `DISPUTE.raised_by_role` also allows `system`; `DISPUTE.resolved_at` added | the no-show trigger opens disputes automatically |
| 7 | `WORKER.avg_rating` is NULL when there are no ratings | 0 would look like "terrible" |
| 8 | CHECK: `verification_status = 'pending'` exactly when `verified_by` is NULL (same idea for disputes) | status and reviewer can never disagree |
| 9 | all timestamps are `timestamptz` | correct across time zones; shown in India time |
| 10 | extra statuses `partially_refunded`, `refunded`, `void` on INVOICE / PAYMENT; `PAYMENT.refund_amount`; `BOOKING.cancelled_by` | the cancellation refund tiers need them |
| 11 | `REQUEST_EMBEDDING_VECTOR` table | requests are embedded once, when posted |

## Design decisions

| # | Question | Decision | Alternative |
|---|---|---|---|
| D1 | Must a worker accept a booking? | No - booking is confirmed instantly (that is what makes the atomic transaction meaningful). Workers see their jobs and, separately, open requests that match their skills. | Add a `pending` booking status and an accept step. |
| D2 | Login | Demo identity picker with a signed cookie; the ER has no credential columns. Roles are enforced on the server. | Password hash column + bcrypt. |
| D3 | Payments | Simulated gateway: paying always succeeds. | Razorpay/Stripe test mode. |
| D4 | Embedding model | all-MiniLM-L6-v2, 384 dims, runs locally in Node, no API key. | multilingual model for Hinglish (same 384 dims). |
| D5 | Ranking | `0.7 x similarity + 0.3 x Bayesian rating / 5`; prior mean 3.5, weight 5; threshold 0.25. Chosen with `npm run eval -- --grid`. | similarity only |
| D6 | Refund policy | customer >= 24 h: 100 %, 2-24 h: 50 %, < 2 h: 0 %; worker/admin cancel: 100 %. Constants at the top of `sp_cancel_booking`. | any thresholds |
| D7 | Location | locality = text filter (no geo distance). | PostGIS |
| D8 | Photos | files in `uploads/<worker_id>/`, MongoDB stores the URL. File type checked from the bytes, random file names. | GridFS / S3 |
| D9 | No cross-database transaction | PostgreSQL is the source of truth; write order PG -> MongoDB -> embeddings; `npm run db:reconcile` repairs drift. | outbox pattern |

## Known limitations (say these in the report - examiners like honesty)

* Filters run after the ANN stage: a very selective filter can return fewer than 10 workers. Mitigation: a bigger candidate pool (`MATCH_ANN_CANDIDATES`).
* The English model does not understand Hinglish ("AC thanda nahi kar raha" fails, see the evaluation).
* No real authentication or payments (D2, D3).
* MongoDB and PostgreSQL can drift if a write fails half-way; it is detected and repaired, not prevented.
