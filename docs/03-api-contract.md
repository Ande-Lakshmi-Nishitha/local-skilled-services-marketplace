# 03 - API contract v1 (frozen after Day 0)

Types live in `contracts/types.ts`. Owner tag: **[A]** Person A, **[B]** Person B. Until the owner ships an endpoint, the consumer codes against the example responses here (mock with a static route or MSW).

## Conventions
- JSON over HTTP, paths under `/api`. Dates are ISO-8601 UTC strings. Money is a JSON number with 2 decimals (INR).
- Session: cookie `sm_session` (signed, HTTP-only) holding `{ role, id, name }`. Helper `requireRole(req, 'customer')` and `getSession(req)` are provided by **[A]** in `lib/session.ts` (Day 2). Until then use a hard-coded session.
- Errors: HTTP status + body `{ "error": { "code": "SLOT_TAKEN", "message": "..." } }`. Codes are the `ErrorCode` union.
- List endpoints return arrays (or the wrapper object shown); no pagination needed at this scale unless stated.

## Database error -> API error mapping (implemented once, in `lib/errors.ts` [A])

| SQLSTATE | Raised by | API code | HTTP |
|---|---|---|---|
| `SM001` | `sp_create_booking`: slot not open / already reserved | `SLOT_TAKEN` | 409 |
| `SM002` | slot already started | `SLOT_IN_PAST` | 422 |
| `SM003` | request not `open` | `REQUEST_NOT_OPEN` | 409 |
| `SM004` | worker not `verified` | `WORKER_NOT_VERIFIED` | 422 |
| `SM005` | slot belongs to a different worker | `SLOT_WORKER_MISMATCH` | 422 |
| `SM006` | cancel on a booking that is not `confirmed` or already started | `BOOKING_NOT_CANCELLABLE` | 409 |
| `SM007` | invoice not `issued` | `INVOICE_NOT_PAYABLE` | 409 |
| `SM008` | status-guard trigger: illegal booking transition | `INVALID_STATUS_TRANSITION` | 409 |
| `SM009` | rating trigger: booking not `completed` | `RATING_NOT_ALLOWED` | 409 |
| `SM010` | dispute not `open` | `DISPUTE_NOT_OPEN` | 409 |
| `SM011` | request does not belong to the calling customer | `REQUEST_NOT_OWNED` | 403 |
| `23P01` | exclusion violation on slots | `SLOT_OVERLAP` | 409 |
| `23505` on `ux_booking_active_slot` | backstop unique index | `SLOT_TAKEN` | 409 |
| `23514`, `22xxx` | CHECK / data exception | `VALIDATION` | 400 |

Procedures raise with: `RAISE EXCEPTION 'SLOT_TAKEN' USING ERRCODE = 'SM001';` (custom SQLSTATE verified to work on PG16; node-pg exposes it as `err.code`).

## Procedure / function signatures (SQL contract, owner [A] unless noted)

```sql
CALL sp_create_booking(p_customer_id int, p_request_id int, p_worker_id int, p_slot_id int, INOUT p_booking_id int);
CALL sp_cancel_booking(p_booking_id int, p_actor_role text, p_actor_id int, p_reason text,
                       INOUT p_refund_amount numeric, INOUT p_policy text);   -- policy: 'full' | 'partial' | 'none'
CALL sp_pay_invoice(p_invoice_id int, p_customer_id int, p_method text, INOUT p_payment_id int);
CALL sp_resolve_dispute(p_dispute_id int, p_admin_id int, p_status text, p_note text, p_refund numeric);
SELECT fn_bayesian_rating(avg_rating numeric, rating_count int);              -- prior mean 3.5, weight 5  (003)
-- [B] 100_matching.sql:
SELECT * FROM fn_match_workers(p_request_id int, p_limit int, p_locality text, p_category_id int,
                               p_alpha numeric, p_min_sim numeric, p_ann_k int);
-- returns worker_id, similarity, trust_score, final_score, next_slot_id, next_slot_start, next_slot_end
```
Call from node-pg like: `await client.query('CALL sp_create_booking($1,$2,$3,$4,NULL::int)', [...])` -> `rows[0].p_booking_id`.

## Dev session [A]
| Method + path | Body | Response |
|---|---|---|
| `GET /api/dev/users` | - | `{ customers: [{id,name}], workers: [{id,name}], admins: [{id,name}] }` |
| `POST /api/dev/login` | `{ role, id }` | `200 { role, id, name }` + sets cookie |
| `POST /api/dev/logout` | - | `204` |
| `GET /api/me` | - | `Session` or `401` |

## Catalogue + requests + matching [B]
| Method + path | Auth | Body / query | Response |
|---|---|---|---|
| `GET /api/categories` | public | - | `CategoryRef[]` |
| `POST /api/requests` | customer | `{ description }` (5-1000 chars) | `201 { request_id, status: "open" }` |
| `GET /api/requests/:id` | owner customer | - | `ServiceRequestDTO` |
| `GET /api/requests` | customer | - | own requests, newest first, `ServiceRequestDTO[]` |
| `GET /api/requests/:id/matches` | owner customer | `?limit=10&locality=&category_id=` | `MatchesResponse` |

Example match response:
```json
{ "request_id": 7,
  "matches": [{
    "worker_id": 6, "name": "Deepak Joshi", "locality": "Indiranagar",
    "bio_snippet": "Air conditioner specialist for split and window units. Servicing, gas top-up, compressor...",
    "hourly_rate": 550, "avg_rating": 3.0, "rating_count": 4,
    "similarity": 0.71, "trust_score": 3.278, "final_score": 0.694,
    "categories": [{ "category_id": 3, "name": "Appliance Repair" }],
    "next_open_slot": { "slot_id": 133, "start_time": "2026-11-04T04:30:00Z", "end_time": "2026-11-04T06:30:00Z" },
    "portfolio_preview": { "trade": "Appliance Repair", "photo_url": "/uploads/6/split-ac-service.jpg" }
  }] }
```
Errors: `404 NOT_FOUND` for unknown/other customer's request; `502 EMBEDDING_FAILED` if the embedder is down.

## Worker profile, portfolio, reverse matching [B]
| Method + path | Auth | Body | Response |
|---|---|---|---|
| `GET /api/workers/:id` | public | - | `WorkerProfileDTO` (PG + Mongo + last 5 ratings) |
| `POST /api/workers` | public (self-registration) | `UpsertWorkerBody` | `201 { worker_id, verification_status: "pending" }` and logs in as that worker |
| `PUT /api/workers/me/profile` | worker | `UpsertWorkerBody` (email immutable) | `200 WorkerProfileDTO`; re-embeds if skills/bio/categories/trade changed |
| `PUT /api/workers/me/portfolio` | worker | `PortfolioDTO` | `200 PortfolioDTO` (re-embeds skills) |
| `POST /api/workers/me/portfolio/photos` | worker | multipart `file`, `caption?` | `201 { url }` (jpg/png/webp, <= 5 MB) |
| `GET /api/workers/me/matched-requests` | worker | `?limit=10` | `[{ request: ServiceRequestDTO, similarity }]` open requests ranked against this worker's embeddings (reverse match; stretch-P1) |

## Availability slots [A]
| Method + path | Auth | Body / query | Response |
|---|---|---|---|
| `GET /api/workers/:id/slots` | public | `?from=ISO&to=ISO&status=open` (defaults: now .. +14 days, `open`) | `SlotDTO[]` |
| `POST /api/workers/me/slots` | worker | `{ slots: [{ start_time, end_time }] }` (all-or-nothing) | `201 SlotDTO[]`; `409 SLOT_OVERLAP` |
| `PATCH /api/workers/me/slots/:id` | worker | `{ status: "open" \| "blocked" }` | `SlotDTO`; `409 SLOT_NOT_EDITABLE` if reserved |
| `DELETE /api/workers/me/slots/:id` | worker | - | `204`; `409 SLOT_NOT_EDITABLE` if reserved |

## Bookings, invoices, payments [A]
| Method + path | Auth | Body | Response |
|---|---|---|---|
| `POST /api/bookings` | customer | `CreateBookingBody` | `201 BookingDTO` (includes invoice). Errors: `SLOT_TAKEN`, `SLOT_IN_PAST`, `REQUEST_NOT_OPEN`, `REQUEST_NOT_OWNED`, `WORKER_NOT_VERIFIED`, `SLOT_WORKER_MISMATCH` |
| `GET /api/bookings` | customer or worker | `?status=` | `BookingDTO[]` - customer: own; worker: own jobs |
| `GET /api/bookings/:id` | customer, worker or admin (party to it) | - | `BookingDTO` |
| `POST /api/bookings/:id/cancel` | customer or worker (party) | `{ reason? }` | `CancelBookingResponse` |
| `POST /api/bookings/:id/complete` | worker | - | `BookingDTO` |
| `POST /api/bookings/:id/no-show` | worker | - | `BookingDTO`; trigger auto-creates a `system` dispute |
| `GET /api/invoices/:id` | party / admin | - | `InvoiceDTO & { payments: PaymentDTO[] }` |
| `POST /api/invoices/:id/pay` | customer | `PayInvoiceBody` | `201 PaymentDTO` |
| `POST /api/bookings/:id/rating` | customer | `RateBody` | `201 { rating_id }`; `RATING_NOT_ALLOWED` unless booking `completed` |
| `POST /api/bookings/:id/disputes` | customer or worker | `{ reason }` | `201 DisputeDTO` |

## Admin and public analytics [A]
| Method + path | Auth | Body / query | Response |
|---|---|---|---|
| `GET /api/admin/workers` | admin | `?status=pending` | workers awaiting review |
| `POST /api/admin/workers/:id/verify` | admin | `{ decision: "verified" \| "rejected" }` | `200` updated worker row |
| `GET /api/admin/disputes` | admin | `?status=open` | `DisputeDTO[]` |
| `POST /api/admin/disputes/:id/resolve` | admin | `{ status: "resolved" \| "rejected", resolution_note, refund_amount? }` | `DisputeDTO` |
| `GET /api/admin/analytics` | admin | - | `{ totals: {bookings, completed, cancelled, no_show, revenue, avg_rating}, bookings_by_category: [...], revenue_by_day: [...], no_show_rate }` (from views) |
| `GET /api/leaderboard` | public | `?category_id=` | `LeaderboardRow[]` (from `v_worker_leaderboard`) |

## Integration checkpoints (who needs what, when)
| By | Person B needs from A | Person A needs from B |
|---|---|---|
| End Day 2 | `lib/db/pg.ts` (pool + `withTx`), `lib/session.ts`, `lib/errors.ts` | - |
| End Week 1 | `GET /api/workers/:id/slots` (for the worker profile page), `fn_bayesian_rating` (003) | `GET /api/categories`; seeded requests have embeddings (`scripts/embed-all.ts` embeds seeded workers and any request without an embedding) |
| End Week 2 | `POST /api/bookings` (results page "Book" button) | `GET /api/requests/:id/matches` returning real data (booking UI needs `worker_id`, `slot_id`) |
| End Week 3 | rating + leaderboard working (trust ranking uses real ratings) | worker profile + portfolio endpoints (admin verification page shows the portfolio) |
