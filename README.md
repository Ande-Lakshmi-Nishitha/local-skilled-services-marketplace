# SkillMarket - Local Skilled-Services Marketplace

Customers describe a problem in plain language ("fan not spinning"); the app finds verified, available local workers by
**meaning**, ranks them by fit and reputation, and books a slot in **one atomic transaction**.
DBMS Experiential Learning project, Level 3.

| Data store | Used for | Advanced features |
|---|---|---|
| PostgreSQL 16 | customers, workers, slots, bookings, invoices, payments, ratings, disputes | transactions, 8 stored procedures, 5 triggers, 5 views, partial / exclusion / composite indexes and constraints |
| pgvector (same PostgreSQL) | embeddings of requests and worker skills | cosine similarity search, HNSW indexes, reverse matching |
| MongoDB 7 | worker portfolios (different fields per trade) | JSON-schema validator, flexible documents |

Stack: Next.js 16 (TypeScript), node-postgres, MongoDB Node driver, `@huggingface/transformers` running
all-MiniLM-L6-v2 locally (no API key), Tailwind CSS, Docker Compose for the databases.

---

## 1. What you need (install once)

| Tool | Check in PowerShell | Get it |
|---|---|---|
| Node.js 20.9 or newer (22 LTS recommended) | `node --version` | https://nodejs.org |
| Git | `git --version` | https://git-scm.com |
| Docker Desktop | `docker --version` | https://www.docker.com/products/docker-desktop |

Docker Desktop must be **open and running** (whale icon in the system tray says "Engine running") before step 4.
If it complains about WSL 2, run `wsl --install` and `wsl --update` in an **Administrator** PowerShell and restart.

> Tip: keep the project in a plain folder such as `C:\dev`, **not** inside OneDrive. OneDrive locks files while
> `npm install` writes thousands of them and causes strange errors.

## 2. Put the project in your GitHub repo

```powershell
mkdir C:\dev -Force; cd C:\dev
git clone https://github.com/Ande-Lakshmi-Nishitha/local-skilled-services-marketplace.git
cd local-skilled-services-marketplace

# remove the old files (keeps the .git folder, so history stays)
Get-ChildItem -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force

# unzip the new project and copy it in
Expand-Archive "$HOME\Downloads\skillmarket.zip" -DestinationPath "$env:TEMP\skillmarket-zip" -Force
Copy-Item "$env:TEMP\skillmarket-zip\skillmarket\*" -Destination . -Recurse -Force
Get-ChildItem -Force     # you should see package.json, src, db, scripts, docs, .gitignore ...
```

## 3. Install

```powershell
npm install
Copy-Item .env.example .env
```
`npm install` takes a few minutes the first time (it downloads Next.js and the ONNX runtime for the model).

> If PowerShell says *"running scripts is disabled on this system"*, run once:
> `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` and answer `Y`.

## 4. Start the databases and load the demo data

```powershell
docker compose up -d --wait
npm run db:reset
```
`db:reset` creates all tables, procedures, triggers and views, loads 40 workers / 6 customers / ~190 past jobs,
creates the MongoDB portfolios and embeds everything. The **first** run downloads the embedding model (~90 MB) into `.hf-cache`.
You should end with a table like: `workers 40, customers 6, worker_vectors 80, mongo_portfolios 40`.

## 5. Run the app

```powershell
npm run dev
```
Open **http://localhost:3000**, click **Sign in as a demo user**, and pick someone:

* **Aarav Patel** (customer) - post a request such as "AC rattling and not cooling", book, pay, cancel. He also has a fan job in progress.
* **Suresh Babu** (worker) - open the in-progress fan job and mark it completed; then Aarav can rate it.
* **Meena Iyer** (worker) - mark the physics session as a no-show (a dispute opens automatically).
* **Diya / Neha** (customers) - cancel paid bookings: Diya gets 100 % back, Neha (~10 h before) gets 50 %.
* **Platform Admin** - KPIs, verify pending workers, resolve disputes with refunds.
* **Register as a new worker** from the sign-in page to see a brand-new MongoDB portfolio and embeddings.

Stop the app with `Ctrl+C`. Stop the databases with `docker compose down` (data is kept) or `docker compose down -v` (data deleted).

## 6. Prove the database features (for the report)

```powershell
npm run test:db            # 47 SQL tests: booking, rollback, refunds, triggers, constraints, matching
npm run test:concurrency   # 20 customers book the same slot at once, 10 rounds: exactly 1 wins each time
npm run eval               # semantic vs keyword vs full-text search -> docs/evidence/eval-results.md
npm run bench              # partial index and HNSW speed-ups -> docs/evidence/bench-results.md
npm run try -- "fan not spinning"     # one query, semantic vs keyword, in the terminal
```
With the app running (`npm run dev` in another window) you can also race through the web API:
`npm run test:concurrency -- --http http://localhost:3000`

Other commands: `npm run check:model` (is the model working?), `npm run db:embed` (re-embed after editing data by hand),
`npm run db:reconcile` (repair PostgreSQL / MongoDB / embedding drift), `npm run build` then `npm start` (production mode).

## 7. Save your work to GitHub

```powershell
git add -A
git status            # .env, node_modules, .next and .hf-cache must NOT be listed (they are git-ignored)
git commit -m "Complete SkillMarket implementation"
git push
```
If you cloned into a new folder, `git push` updates `main` on GitHub. Git may open a browser window to sign you in the first time.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `failed to connect to the docker API ... dockerDesktopLinuxEngine` | Docker Desktop is not running. Open it, wait for "Engine running", retry. |
| `port is already allocated` (5432 or 27017) | Another PostgreSQL/MongoDB is running on your PC. Stop it (Services app), or change the left port in `docker-compose.yml` (e.g. `"5433:5432"`) **and** the port in `POSTGRES_URL` in `.env`. |
| `Cannot connect to PostgreSQL` in `db:reset` | `docker compose ps` should show both containers as healthy; run `docker compose up -d --wait` again. |
| `Could not load the embedding model` | The download from huggingface.co failed (college/office networks often block it). Try another network once - after that it is cached. Or set `HF_REMOTE_HOST=https://hf-mirror.com/` in `.env`. Last resort: `EMBEDDING_PROVIDER=hash` (works offline but is **not** semantic). Then `npm run db:reset` again. |
| Matches are empty | Run `npm run db:embed`; check `npm run check:model`. |
| The demo "in-progress" jobs are gone / too old | They are timed relative to the reset: run `npm run db:reset` before demoing. |
| `npm install` fails on OneDrive | Move the folder to `C:\dev` and install again. |
| `next dev` shows an old page after `db:reset` | Sign out ("Switch user") and sign in again: ids are re-created by the reset. |

## Project layout

```
db/postgres/migrations/   001 schema, 002 vectors, 003 functions+triggers, 004 procedures, 005 views, 006 matching
db/postgres/seed/         reference data, slots + past jobs, live demo bookings
db/postgres/tests/        SQL test suites (npm run test:db)
db/seed/workers.json      40 workers -> PostgreSQL rows AND MongoDB portfolios
scripts/                  db-reset, embed-all, reconcile, test-concurrency, eval-matching, bench, try-match, check-model
src/lib/                  db, mongo, embeddings, session, errors, services/*
src/app/                  pages for customer, worker, admin; actions.ts (forms); api/** (JSON API)
docs/                     architecture, database reference, ER changes, demo + viva guide, evidence/
```
Start with `docs/01-architecture.md`. Results measured while building this are in `docs/evidence/`.
