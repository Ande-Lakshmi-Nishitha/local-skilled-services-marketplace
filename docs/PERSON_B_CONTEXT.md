# PERSON B - Semantic Matching & Flexible Data (context document)

> **How to use:** read once fully, then keep open. If you use an AI assistant, paste this file plus `docs/02-architecture.md` and `docs/03-api-contract.md` at the start of each session and say "I am Person B".
> Person A's counterpart is `PERSON_A_CONTEXT.md`. You only need its handshake (your section 4).

## 1. The project in 60 seconds
A web marketplace for local skilled workers (electricians, plumbers, tutors, maids, appliance repair). A customer types a problem in plain language ("AC not cooling, rattling noise"); the system finds relevant, available, verified workers by *meaning*, ranks them by similarity + rating, and lets the customer book a slot (that last part is Person A's).
Three databases, each chosen for its data shape: **PostgreSQL** (transactions), **pgvector** (semantic search, inside PostgreSQL), **MongoDB** (variable worker portfolios). The course project is about showing *why* each.

## 2. Your mission
You own the **"find the right worker" half**: turning text into vectors, searching and ranking them, and the flexible worker data (portfolios) that does not fit a relational table. You also own the experiments that *prove* the vector and NoSQL choices were worth it.

**Done means:** acceptance tests AT-01 .. AT-07 in `05-test-and-demo-plan.md` pass; the evaluation table and HNSW benchmark exist; customer search/results/profile screens and the worker portal (profile, portfolio, availability editor) work end to end.

## 3. What you own

| Area | Files / objects |
|---|---|
| Migrations | `002_vector.sql` (given, you own changes), `100_*` .. `199_*` (e.g. `100_matching.sql`) |
| SQL objects | `fn_match_workers` (starter: `db/postgres/reference/matching_skeleton.sql`), reverse-match function |
| MongoDB | `db/mongo/init.js`, `seed.js`, collection `worker_portfolio` |
| API | `/api/categories`, `/api/requests*`, `/api/workers` (register), `/api/workers/:id`, `/api/workers/me/profile`, `/api/workers/me/portfolio*`, `/api/workers/me/matched-requests` |
| Libs | `web/src/lib/embeddings/`, `lib/matching/`, `lib/db/mongo.ts` |
| Screens | customer: Post request, Results (ranked cards), Worker profile + portfolio - worker: Onboarding/Profile editor, Portfolio editor (trade-specific forms + photo upload), Availability editor, Matched requests |
| Scripts | `scripts/embed-all.ts`, `reconcile.ts`, `gen-dataset.ts`, `eval-matching.ts`, `bench-hnsw.ts`, `db/postgres/tests/B_*` |

Do **not** edit: `001_core_schema.sql` (ask A), `003`-`099` migrations, bookings/payments/admin code, `lib/db/pg.ts`, `session.ts`, `errors.ts` (use them), `nav.ts` (append your links only).

## 4. Handshake with Person A

**You get from A** (deadlines in `03-api-contract.md`): `lib/db/pg.ts` (`pool`, `withTx`), `lib/session.ts`, `lib/errors.ts` (end Day 2 - until then write your queries with a local `pg` Pool); `fn_bayesian_rating` (end Week 1; until then use the inline expression in the skeleton); `GET /api/workers/:id/slots` (Week 1) and `POST /api/bookings` (Week 2) for your results/profile pages.
**You give A:** `GET /api/categories` (Week 1); `GET /api/requests/:id/matches` with real data (Week 2); worker profile + portfolio endpoints (Week 3). Until then Person A builds from the example JSON in the contract.
**Shared:** `db/postgres/seed/*`. Need more seed data (e.g. 100 workers)? Generate it with your own script into a *separate* file/seed path; do not rewrite 001/002.

## 5. Day-1 checklist
1. `cp .env.example .env && docker compose up -d --wait && ./scripts/db-reset.sh`
2. In `psql`: `\d+ worker_embedding_vector`, `\di *hnsw*`. In `mongosh`: `use skillmarket; db.worker_portfolio.find().pretty()` - note how the four documents differ.
3. Prove the embedder works **outside Next.js first** (a plain Node script): load `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` (feature-extraction pipeline, `pooling: 'mean'`, `normalize: true`), embed "AC not cooling" and "air conditioner weak cooling" and "teach me algebra", print cosine similarities. Expect the first two to be clearly higher than the third. Time a cold and warm call.
4. Define the interface and never let callers know which model you use:
```ts
export interface Embedder { dim: number; embed(text: string): Promise<number[]>; embedBatch(texts: string[]): Promise<number[][]> }
```
Assert `vec.length === Number(process.env.EMBEDDING_DIM)` on every call (fail loudly on a mismatch with `vector(384)`).
5. Run the reference query: copy `matching_skeleton.sql` content into a scratch session, run `scripts/embed-all.ts` (you write it, task B4), insert one request + embedding by hand, call `fn_match_workers_ref(<id>)`. Read every CTE until you could redraw it.

## 6. Detailed specs

### 6.1 What text gets embedded (decide once, document, keep stable)
| Row | `source_type` | Text |
|---|---|---|
| Worker skills | `skill` | `"{trade}. Services: {category names joined by ', '}. Skills: {trade_attributes.skills joined by ', '}."` |
| Worker bio | `bio` | `worker.bio` verbatim (trimmed; skip the row if empty) |
| Request | - | `description` verbatim (trim, collapse whitespace; no query rewriting in v1) |

`trade_attributes.skills: string[]` is the one agreed key in the otherwise free-form Mongo attributes (see `contracts/types.ts`). Store `source_text` so you can see *what* was embedded when debugging.
Model note: if you move to `multilingual-e5-small` (also 384-dim, handles Hinglish) it expects `"query: "` / `"passage: "` prefixes - handle that inside the `Embedder`, nowhere else.

### 6.2 Write order and consistency (D9)
Worker create/update: (1) PostgreSQL transaction (worker + categories) -> commit; (2) Mongo upsert by `worker_id`; (3) embeddings upsert (`INSERT ... ON CONFLICT (worker_id, source_type) DO UPDATE`). Steps 2-3 failing must not roll back step 1: retry once, log, return success with a warning flag in the log. `scripts/reconcile.ts`: lists workers with no Mongo doc or fewer embedding rows than expected, and fixes them (re-embed from PG + Mongo). Also remove embeddings/Mongo docs whose worker no longer exists. Re-embed only when skills/bio/categories/trade actually changed (compare `source_text`).
Request create: embed *first*, then one PG transaction inserting `service_request` + `request_embedding_vector` (so you never store a request without its vector). If embedding fails -> `502 EMBEDDING_FAILED`, nothing stored.

### 6.3 Matching (`100_matching.sql` -> `fn_match_workers`)
Start from the skeleton; signature and return columns are fixed by the contract. Requirements:
- ANN stage must hit the HNSW index (`ORDER BY embedding <=> q LIMIT k`; confirm with `EXPLAIN` - AT-05).
- Best similarity per worker over their `skill` and `bio` rows.
- Filters: verified only, `similarity >= p_min_sim`, optional locality/category, at least one `open` slot with `start_time > now()`; return the *earliest* such slot.
- Score: `final = alpha * similarity + (1 - alpha) * trust / 5`, trust from `fn_bayesian_rating` (Person A, migration 003).
- Deterministic tie-break (`ORDER BY final_score DESC, worker_id`).
- Think about and document: result count < limit when filters are selective (over-fetch `p_ann_k`, check if your pgvector version supports iterative scans: `SELECT extversion FROM pg_extension WHERE extname='vector'`), and what a *low-confidence* result looks like (best similarity < ~0.35 -> UI says "no strong matches, here are the closest").

App layer (`lib/matching/`): call the function, then **one** Mongo query `find({ worker_id: { $in: ids } })` for portfolio previews, then merge; also one SQL query for categories of those worker ids. No N+1.

### 6.4 MongoDB rules
- One document per worker; unique index on `worker_id` (already in `init.js`).
- Shared validated fields only: `worker_id`, `trade`, `photos[]`, `certifications[]`, `updated_at`; everything trade-specific goes in `trade_attributes`.
- Trade-specific examples to support in the portfolio editor (render a different form per trade): electrician (`license_no`, `license_valid_till`, `voltage_certified[]`, `emergency_service`), appliance (`brands_serviced[]`, `spare_parts_warranty_days`), tutor (`subjects[]`, `grade_levels[]`, `board`, `mode[]`, `free_demo_class`), maid (`references[]`, `languages[]`, `police_verification`). A "generic" form (key/value rows) covers any other trade - that is the AT-06 demo.
- Photos: save to `web/public/uploads/<worker_id>/`, validate type (jpg/png/webp) and size (<= 5 MB), generate a safe filename (never use the uploaded name), store `{ url, caption, uploaded_at }` in Mongo.

### 6.5 Reverse matching (stretch-P1, closes the synopsis' "workers view matched jobs")
For a worker, take their embeddings, find open `service_request`s with the nearest `request_embedding_vector` (HNSW on the request table exists for this), exclude requests that already have a live booking, return ranked with similarity. Read-only; the customer still chooses who to book.

### 6.6 Evaluation protocol (the single most valuable artefact you produce)
1. **Dataset** (`gen-dataset.ts`): 60-100 synthetic workers across the 8 categories (8-12 each), bios written in *varied* styles and vocabulary; keep it reproducible (seeded RNG or committed JSON). Use an LLM to write bios and queries if you like, then review them.
2. **Queries:** 40 customer-style queries, each labelled with the set of relevant trades. Mark a **hard subset** (>= 15) automatically: queries sharing no (stop-word-filtered, stemmed) token with the bios of the relevant workers - the vocabulary-mismatch case that keyword search cannot solve.
3. **Systems compared:** (a) keyword `ILIKE` any token, (b) PostgreSQL full-text (`websearch_to_tsquery` with OR semantics over bio + skills), (c) your semantic pipeline (similarity only), (d) semantic + trust ranking.
4. **Metrics:** Precision@5, hit@3 (any relevant in top 3), MRR; report on all 40 and on the hard subset separately. Relevance = worker's trade in the query's label set.
5. Tune `MATCH_ALPHA` and `MATCH_MIN_SIMILARITY` on the eval set; record the grid and the chosen values. Keep one held-out quarter of the queries untouched until the end to avoid fooling yourself.

### 6.7 HNSW benchmark (`bench-hnsw.ts`)
Insert synthetic embeddings at 10k, 50k, 100k rows (embed real texts and add noisy variants, or use clustered random unit vectors). For 100 query vectors compare exact (`SET enable_indexscan = off` or drop the index) vs HNSW at `hnsw.ef_search` 40 / 100 / 200: mean latency (`EXPLAIN ANALYZE`) and **recall@10** = |HNSW top-10 intersect exact top-10| / 10. Present a small table + one chart. Be ready to explain `m`, `ef_construction`, `ef_search` trade-offs.

### 6.8 Screens (keep them simple, state-complete)
- **Post request:** textarea, example chips, submit -> results page. **Results:** card per match (name, locality, rate, rating + count, bio snippet, categories, portfolio thumbnail, next open slot, similarity as a small bar), filters (locality, category), "Book this slot" button (calls A's endpoint; before it exists, disabled with a tooltip), states: loading, no matches, low-confidence.
- **Worker profile:** header, rating + recent reviews, portfolio rendered from `trade_attributes` generically (key/value + arrays as chips), certifications, photo gallery, slot picker (A's slots API).
- **Worker portal:** onboarding form (creates a `pending` worker), profile editor, portfolio editor, availability editor (week grid; calls A's slots API; shows overlap errors), "Matched requests" list.

## 7. Dependencies on tooling
`npm i @huggingface/transformers mongodb pgvector` (+ `pg` types from A). Cache directory for model files: `.hf-cache/` (git-ignored). Warm the model when the server boots (e.g. on first import of `lib/embeddings`) so the first user request is not 5-10 s.

## 8. Backlog (priority, hours, target week)

| # | Task | P | Hours | Week |
|---|------|---|-------|------|
| B1 | Embedding module: model load, `embed`/`embedBatch`, normalise, dim assert, `pgvector` helper, tests | P0 | 5 | 1 |
| B2 | Mongo client + validator + portfolio CRUD API | P0 | 5 | 1-2 |
| B3 | Worker registration/profile API (PG tx -> Mongo -> embeddings), `reconcile.ts` | P0 | 8 | 2 |
| B4 | `embed-all.ts` (seeded workers + any request lacking an embedding) + `GET /api/categories` | P0 | 3 | 1 |
| B5 | `fn_match_workers` (migration 100), tuned, with SQL tests AT-01..AT-05 | P0 | 8 | 1-2 |
| B6 | `POST /api/requests`, `GET /api/requests/:id`, `/matches` (+ Mongo preview merge) | P0 | 6 | 2 |
| B7 | Customer UI: post request, results, worker profile with portfolio | P0 | 10 | 2-3 |
| B8 | Worker portal UI: onboarding, profile, portfolio forms + upload, availability editor | P0 | 12 | 3 |
| B9 | Reverse matching function + endpoint + UI list | P1 | 4 | 3 |
| B10 | Dataset generator (60-100 workers, 40 labelled queries) | P0 | 6 | 3 |
| B11 | `eval-matching.ts` + tuning + write-up table | P0 | 6 | 4 |
| B12 | `bench-hnsw.ts` + evidence | P1 | 4 | 4 |
| B13 | *Stretch:* multilingual model / Hinglish queries, re-run eval | P2 | 3 | 5 |
| | **Core total (B1-B12)** | | **77** | |

Suggested order: B1 -> B4 -> B5 first (that unblocks Person A's UI), then B2/B3/B6, UI last.

## 9. How to test as you go
- SQL: `db/postgres/tests/B_matching.sql` - insert controlled fake vectors (unit vectors along chosen axes) so expected ranking is obvious, then assert order, filters, threshold, availability, unverified exclusion.
- Embedder sanity: paraphrases score higher than unrelated pairs (assert in a unit test with a margin, not exact numbers).
- Regression guard: keep the 40-query eval runnable with one command and re-run after every change to texts, model, alpha or threshold.
- Full list: `05-test-and-demo-plan.md` (AT-01..AT-07).

## 10. Pitfalls
- **Operator/opclass mismatch:** `vector_cosine_ops` index is only used with `<=>`. Using `<->` (L2) or an expression that wraps the column silently falls back to a sequential scan.
- Forgetting to normalise vectors or mixing models between request and worker embeddings.
- Passing arrays to `pg` without converting to the pgvector text form (`pgvector.toSql(vec)`).
- Embedding on every page view; embed on write only.
- Treating similarity numbers as probabilities; they are relative. Tune the threshold on data.
- Filtering before the ANN stage in a way that defeats the index; know the trade-off (section 6.3).
- Trusting the Mongo doc over PostgreSQL for "does this worker exist/is verified".
- Storing uploads under the original filename (path traversal / overwrite).
- Seed/worker-id assumptions: `db/mongo/seed.js` assumes a fresh reset (worker ids 1..13).

## 11. Questions you should be able to answer in the viva
1. Why did keyword search fail for "fan not spinning"? Show the numbers from your evaluation.
2. What is an embedding, what does cosine similarity measure, and why normalise vectors?
3. How does HNSW work at a high level, and what do `m`, `ef_construction`, `ef_search` control? What did your benchmark show (latency vs recall)?
4. Why is pgvector in the same PostgreSQL rather than a separate vector database? What do you gain in this query and what do you give up?
5. Why Bayesian smoothing of ratings, and how did you choose alpha and the similarity threshold?
6. Why MongoDB for portfolios? What would the relational schema look like and what is wrong with it? When would you *not* use MongoDB here?
7. There is no transaction across PostgreSQL, MongoDB and the vector rows. What can go wrong, in which order do you write, and how do you repair?
8. Why filter after the ANN stage and what limitation does that create?
9. How do you know your ranking is good and not just plausible-looking?
10. What changes if you swap the embedding model?

## 12. Working agreements
Branch `b/<task>`, small PRs, Person A reviews. Contract changes go through `CHANGELOG.md` first. Save evaluation tables, benchmark outputs and screenshots to `docs/evidence/` the moment you produce them. Commit the dataset generator and queries so results are reproducible.
