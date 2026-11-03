# Local Skilled-Services Marketplace

Semantic request-to-worker matching for home and trade services. DBMS Experiential Learning, Level 3.
PostgreSQL (ACID core) + pgvector (semantic search) + MongoDB (flexible worker portfolios), with a Next.js app on top.

## Start here
1. Read `docs/04-decisions-and-er-changes.md` together (15 min) and confirm the open decisions.
2. Each person reads their own context doc:
   - **Person A - Transactional core:** `docs/PERSON_A_CONTEXT.md`
   - **Person B - Semantic matching & flexible data:** `docs/PERSON_B_CONTEXT.md`
3. Both skim `docs/01-execution-plan.md`, `docs/02-architecture.md`, `docs/03-api-contract.md`.

## Quick start (about 5 minutes)
Prerequisites: Docker with Compose v2, Node 20+, `git`.
```bash
cp .env.example .env
docker compose up -d --wait
./scripts/db-reset.sh          # applies migrations + seed to PostgreSQL, initialises MongoDB
```
Sanity check:
```bash
docker compose exec postgres psql -U skillmarket skillmarket -c "SELECT name, locality, avg_rating FROM worker ORDER BY worker_id;"
docker compose exec mongo mongosh --quiet skillmarket --eval "db.worker_portfolio.countDocuments()"   # 4
```
Then Person A scaffolds the app into `web/` (`npx create-next-app@latest web`, see their Day-1 checklist) and pushes.

## What is in this kit

| Path | What |
|---|---|
| `docs/01-execution-plan.md` | phases, milestones, risks, evidence list |
| `docs/02-architecture.md` | diagram, data flows, integrity design, repo layout + file ownership |
| `docs/03-api-contract.md` + `contracts/types.ts` | every endpoint, DTO, error code, procedure signature |
| `docs/04-decisions-and-er-changes.md` | 10 ER changes already in the schema + 9 decisions to confirm |
| `docs/05-test-and-demo-plan.md` | 20 acceptance tests, 8-minute demo script, report outline |
| `docs/PERSON_A_CONTEXT.md`, `docs/PERSON_B_CONTEXT.md` | everything each person needs to start |
| `db/postgres/migrations/` | `001_core_schema.sql`, `002_vector.sql` (tested on PostgreSQL 16 + pgvector) |
| `db/postgres/seed/` | 13 workers (2 pending), 5 customers, slots, 44 past completed jobs with ratings |
| `db/postgres/reference/matching_skeleton.sql` | tested starting point for Person B's matching function |
| `db/mongo/` | collection validator + 4 sample portfolios with different shapes |
| `scripts/db-reset.sh` | rebuilds both databases from scratch |
| `CLAUDE.md` | short rules file for AI coding assistants |

## Conventions
Migrations: 001-099 Person A, 100-199 Person B. Contract changes: log in `docs/CHANGELOG.md` first. Reset DBs freely with `./scripts/db-reset.sh` (destroys local data).
