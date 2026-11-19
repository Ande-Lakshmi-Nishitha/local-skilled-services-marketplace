# Demo script and viva preparation

Run `npm run db:reset` shortly before the demo (the demo bookings are timed relative to the reset).

## 8-minute demo

| Min | Who / where | Do | Point out |
|---|---|---|---|
| 0:00 | landing page | the three-store slide (or the three cards on the home page) | each store chosen for its data shape |
| 0:45 | sign in as **Aarav** | post "My AC is rattling and the room never gets cold" | top match is the AC technician; the side panel shows what keyword search finds |
| 1:45 | same page | open the worker's profile, then a tutor's and a maid's profile | different portfolio fields per trade = MongoDB |
| 2:30 | back to matches | click a slot -> booking page -> pay with UPI | one procedure did booking + slot + request + invoice |
| 3:15 | terminal | `npm run test:concurrency` | 20 simultaneous attempts, exactly one wins, every round |
| 4:00 | sign in as **Neha** | cancel her booking (starts in ~10 h) | 50 % refund from `sp_cancel_booking` |
| 4:30 | sign in as **Suresh** (worker) | open the in-progress fan job -> Mark job completed | |
| 4:50 | sign in as **Aarav** | rate it 5 stars | trigger updates the worker average immediately |
| 5:15 | sign in as **Meena** (worker) | mark the physics session as no-show | trigger opens a dispute |
| 5:40 | sign in as **Admin** | KPIs (views), verify a pending worker, resolve Sanjay's dispute with a refund | |
| 6:30 | Leaderboard page | | RANK() per category on a Bayesian score |
| 7:00 | `docs/evidence/` | evaluation table and benchmark table | semantic beats keyword; partial index and HNSW speed-ups |
| 7:45 | | questions | |

## Questions you should be able to answer

**Transactions and concurrency**
1. *Two customers click Book on the same slot at the same moment. What happens?* Both call `sp_create_booking`. The first takes the row lock (`FOR UPDATE`) on the slot; the second blocks. The first commits with the slot `reserved`; the second then reads the committed row, sees it is not `open` and raises `SLOT_TAKEN`. The partial unique index is a second line of defence.
2. *Why a row lock AND a unique index?* The lock gives a clean, early error; the index guarantees correctness even for code that does not use the procedure (test B8).
3. *Why one transaction?* If the invoice insert fails after the booking insert, we would have a booked slot with no invoice. Test B7 forces that failure and shows nothing is left behind.
4. *Why not SERIALIZABLE?* Not needed: the lock + index already serialise the only conflict. SERIALIZABLE would also work but needs retry logic.
5. *Deadlocks?* All procedures lock in the same order (booking -> slot -> request -> invoice -> payment).

**Triggers, procedures, views**
6. *How is avg_rating kept correct?* Trigger T2 recomputes it on insert, update and delete, after locking the worker row so concurrent ratings do not lose updates.
7. *Procedure vs function?* A procedure is called with CALL, can return values through INOUT parameters and is used for actions; functions return values/tables and are used inside queries (`fn_match_workers`, `fn_bayesian_rating`).
8. *Bayesian rating?* `(n x avg + 5 x 3.5) / (n + 5)`: few ratings are pulled toward 3.5, so 1 x 5.0 = 3.75 scores below 40 x 4.6 = 4.48.

**Vectors**
9. *What is an embedding / cosine similarity?* A 384-number representation of the meaning of a text; cosine similarity measures the angle between two such vectors (1 = same direction).
10. *How does HNSW work?* A layered graph of vectors; search starts at the top sparse layer and greedily walks to closer neighbours, layer by layer. `m` = links per node, `ef_construction` = effort when building, `ef_search` = candidates kept while searching (higher = better recall, slower). See the benchmark.
11. *Why pgvector instead of a separate vector database?* One query can combine similarity with verification, availability and ratings, with transactions and no data to sync. A dedicated vector DB scales further but needs syncing.
12. *How do you know matching is good?* `npm run eval`: labelled queries, compared with keyword and full-text search (hit@1, hit@3, MRR), including a "hard" subset with no shared words.

**MongoDB**
13. *Why MongoDB for portfolios?* Each trade has different attributes; one document per worker stores them without NULL-filled columns or EAV tables. Show the gardener with `plants_handled` added without any schema change.
14. *How do you keep MongoDB consistent with PostgreSQL?* PostgreSQL first, then MongoDB, then embeddings; retry once; `npm run db:reconcile` finds and repairs drift.
