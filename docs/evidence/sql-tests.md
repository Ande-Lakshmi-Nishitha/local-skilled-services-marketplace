# SQL test results

Output of `npm run test:db` on 2026-11-11, PostgreSQL 16 + pgvector.

```

== 01_booking.sql
  ✓ B1 booking creates booking + reserves slot + books request + invoice of rate x 1.5 h
  ✓ B2 second booking of a reserved slot -> SLOT_TAKEN
  ✓ B3 slot does not belong to the chosen worker -> SLOT_WORKER_MISMATCH
  ✓ B4 slot in the past -> SLOT_IN_PAST
  ✓ B5 pending worker cannot be booked -> WORKER_NOT_VERIFIED
  ✓ B6a booking someone else's request -> FORBIDDEN
  ✓ B6b request that is already booked -> REQUEST_NOT_OPEN
  ✓ B7 failure in the last step rolls back the booking, the slot and the request (atomicity)
  ✓ B8 unique index ux_booking_active_slot blocks a second live booking (backstop)
  ✓ B9a paying marks invoice paid and records a successful payment
  ✓ B9b paying twice -> INVOICE_NOT_PAYABLE
  ✓ B9c paying another customer's invoice -> FORBIDDEN

== 02_cancel_refund.sql
  ✓ C1 customer cancels 30 h ahead -> 100 % refund, slot and request re-opened
  ✓ C2 customer cancels 5 h ahead -> 50 % refund
  ✓ C3 customer cancels 1 h ahead -> 0 % refund, invoice stays paid
  ✓ C4 worker cancels -> always 100 % refund, slot becomes blocked
  ✓ C5 cancelling an unpaid booking voids the invoice
  ✓ C6a cancelling a cancelled booking -> BOOKING_NOT_CANCELLABLE
  ✓ C6b another customer cannot cancel -> FORBIDDEN
  ✓ C7 a cancelled slot can be rebooked (partial unique index)

== 03_triggers_and_admin.sql
  ✓ T1 rating a booking that is not completed -> RATING_NOT_ALLOWED
  ✓ T2a worker completes a started booking, request closed
  ✓ T2b new rating recomputes avg_rating and rating_count (trigger)
  ✓ T2c a booking can be rated only once
  ✓ T2d deleting the rating restores the previous average
  ✓ T3 completed -> confirmed is rejected by the status guard
  ✓ T4a marking no-show auto-creates one open system dispute
  ✓ T4b cannot complete a job before it starts -> TOO_EARLY
  ✓ T4c another worker cannot report the outcome -> FORBIDDEN
  ✓ T5a deleting a booked slot -> SLOT_NOT_EDITABLE
  ✓ T5b re-opening a booked slot by hand -> SLOT_NOT_EDITABLE
  ✓ O1 overlapping slot for the same worker -> exclusion constraint
  ✓ O2 back-to-back slot (end = next start) is allowed
  ✓ D1 refund larger than the payment -> INVALID_REFUND
  ✓ D2 resolving with a refund updates payment, invoice and dispute
  ✓ D3 a resolved dispute cannot be resolved again -> DISPUTE_NOT_OPEN
  ✓ V1 leaderboard lists only verified workers and has a #1 in every category
  ✓ V2 fn_bayesian_rating: 1 x 5.0 ranks below 40 x 4.6
  ✓ R1 admin verification sets status and reviewer

== 04_matching.sql
  ✓ M1 ranked by similarity; orthogonal worker dropped by threshold; pending worker excluded
  ✓ M2 locality filter
  ✓ M3 category filter (no plumber is similar enough)
  ✓ M4 returns the earliest open future slot
  ✓ M5 a worker with no open future slot is not matched
  ✓ M6 equal similarity -> higher Bayesian rating ranks first
  ✓ M7 ORDER BY embedding <=> q LIMIT k uses the HNSW index
  ✓ M8 reverse matching finds the open request that fits the worker

47 passed, 0 failed
```
