# Project context for AI coding assistants

Local Skilled-Services Marketplace: customers describe a problem in plain language, the system semantically matches
them to available, verified workers and books a slot atomically. DBMS Experiential Learning project (Level 3).

**Two people work in parallel. Before doing anything, identify which one you are helping and read ONLY:**
- `docs/PERSON_A_CONTEXT.md` (transactional core: PostgreSQL logic, bookings, payments, admin), or
- `docs/PERSON_B_CONTEXT.md` (semantic matching: pgvector, embeddings, MongoDB portfolios, worker/customer search UI).
Then skim `docs/02-architecture.md` and `docs/03-api-contract.md` (shared, frozen).

## Hard rules
- Three stores, each justified by its data shape: PostgreSQL (ACID), pgvector inside the same PostgreSQL (embeddings, dim 384, cosine, HNSW), MongoDB (worker portfolios).
- Business rules that must never be violated live **in the database** (constraints, triggers, procedures), not only in app code.
- Do not edit files owned by the other person (ownership table in `docs/02-architecture.md` section 8). Open a note in `docs/CHANGELOG.md` instead.
- Migration numbers: 001-099 Person A, 100-199 Person B. Never edit an applied migration after Day 1 freeze without a CHANGELOG entry; add a new one.
- API shapes and enums are defined in `contracts/types.ts`. Do not invent fields.
- Stack: Next.js (App Router, TypeScript) in `web/`, `pg` for PostgreSQL, official `mongodb` driver, no ORM for the booking path.
- Reset databases any time with `./scripts/db-reset.sh`.
