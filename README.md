# marketing-agent — Phase 1

Backend service for the Marketing AI Agent. A **standalone project**: its own
dependencies, its own database schema, its own processes.

```
Marketing AI Agent Main/
├── project/            NXT Sales (untouched)
└── marketing-agent/    this project
```

Nothing is shared at the filesystem or database level. The only coupling is
**HTTP**.

**No NXT Sales application code was changed to build this.** The service reads
the CRM through its existing REST API using a JWT it mints for a dedicated
service-account user, which `authMiddleware.js` already accepts as-is.

---

## What Phase 1 does

Takes a marketing objective in plain language and produces an **approved
campaign package**:

```
INTAKE → ICP_SYNTHESIS → SEGMENT_PROPOSE → SEGMENT_RESOLVE → RESEARCH
       → STRATEGY → [HUMAN GATE 1] → CONTENT_GENERATE → CONTENT_VALIDATE
       → [HUMAN GATE 2] → PACKAGE
```

## What Phase 1 does NOT do

- Send email, publish to LinkedIn/Meta, or cause **any** external effect
- Write anything back to NXT Sales
- Ship a frontend
- Use n8n

These are not disabled flags. **The tool registry contains no write tools, and
`CrmPort` has no write methods**, so a Phase 1 run cannot alter CRM data or
reach the outside world regardless of what any model produces. The safety
property is structural, and `tests/unit/toolRegistry.test.ts` asserts it.

---

## Setup

### 1. Prerequisites

| Requirement | Status on this machine |
|---|---|
| Node 22+ | ✅ |
| Postgres with `pgvector` for the marketing schema | ✅ via the dev container below |
| NXT Sales database (`nxt_marketwiz`) | ❌ does not exist here, and no dump is present — restore per `../project/docs/RESTORE_PROJECT.md` |

Neither local Postgres has `pgvector` (PG 13 on :5432, PG 18 on :5433, no
extension files on disk), so the validated dev setup runs the marketing database
in a container. This touches neither local server:

```bash
docker run -d --name marketing-agent-db   -e POSTGRES_PASSWORD=marketing_dev_pw   -e POSTGRES_DB=marketing_agent_dev   -p 5434:5432 pgvector/pgvector:pg17
```

> **For production** the marketing schema is still meant to live beside NXT Sales
> in one database. That needs `pgvector` installed into the PostgreSQL 18
> instance — [release binaries](https://github.com/pgvector/pgvector) matching
> the server version, copied into its `lib/` and `share/extension/`. The
> container validates the code; it is not the deployment target.

### 2. Configure

```bash
cp .env.example .env
```

`.env` is gitignored. Fill in:

| Variable | Notes |
|---|---|
| `MARKETING_DATABASE_URL` | `?schema=marketing`. Dev: the container on **:5434**. Production: alongside NXT Sales on the PG 18 instance (**:5433** — 5432 is PostgreSQL 13) |
| `MARKETING_ADMIN_URL` | Superuser URL, used only by `db:extensions` / `db:indexes` |
| `JWT_SECRET` | **Must be byte-identical to `../project/server/.env`** — already synced |
| `NXT_SALES_SERVICE_USER_ID` | See *Service account* below |
| `BOOTSTRAP_ADMIN_EMAIL` | First login with this email is granted the tenant admin role |
| `GEMINI_API_KEY` | Already set |

Every value is validated at boot. A missing or malformed one **stops the
process** — there is no `'dev-secret'`-style fallback anywhere in this service.

### 3. Service account

The agent calls NXT Sales as a real user, because that is what
`authMiddleware.js` accepts. Create (or designate) one user for it and put its
`User.id` in `NXT_SALES_SERVICE_USER_ID`:

```sql
-- run against the NXT Sales database, not this project's
SELECT id, email FROM "User" WHERE email = 'marketing-agent@service.local';
```

> **Known limitation, deliberately accepted for Phase 1.** NXT Sales enforces
> no role checks anywhere, so this token has the same reach any logged-in user
> has. Phase 1 contains that by having no write methods at all on `CrmPort`.
> Narrowing the credential itself is the Phase 0 RBAC work in NXT Sales and is
> still outstanding — it is not assumed to be in place.

### 4. Database

Order matters: the `vector` type must exist before Prisma can create a
`vector(768)` column.

```bash
npm run db:extensions   # CREATE SCHEMA marketing; CREATE EXTENSION vector SCHEMA marketing;
npm run db:deploy       # applies prisma/migrations
npm run db:indexes      # HNSW + GIN indexes Prisma cannot express
npm run db:seed         # tenant, bootstrap admin, 7 built-in prompts
```

The extension is installed **into the `marketing` schema**, not `public`.
`?schema=marketing` makes Prisma connect with `search_path = marketing` alone,
so an extension in `public` is invisible and the migration fails with
`type "vector" does not exist` despite the extension plainly being installed.
`sql/002_indexes.sql` sets `search_path` for the same reason.

If a migration fails partway, reset before retrying — Prisma refuses to continue
past a failed migration:

```bash
docker exec marketing-agent-db psql -U postgres -d marketing_agent_dev   -c 'DROP SCHEMA IF EXISTS marketing CASCADE;'
```

### 5. Run

Two processes. The worker is separate on purpose: a long agent step must not be
able to make the API unresponsive — the exact failure mode this service exists
to keep out of NXT Sales' single process.

```bash
npm run dev          # API    → http://localhost:4100
npm run dev:worker   # worker → consumes run.step and knowledge.ingest
```

On a memory-constrained machine run the compiled build instead — two `tsx watch`
processes alongside Docker exhausted the heap here and the worker died with
`Fatal process out of memory` before it ever consumed a job:

```bash
npm run build && node dist/index.js   # and, separately, node dist/worker.js
```

There is no parent `package.json`. This project is started on its own, from
this directory. NXT Sales keeps its own `npm run dev` under `../project/`,
and neither knows about the other.

---

## Using it

Authenticate with a normal NXT Sales JWT (log in to the CRM, copy `mwz_token`
from `localStorage`).

```bash
TOKEN=<your NXT Sales JWT>

# who am I, and what may I do
curl -H "Authorization: Bearer $TOKEN" localhost:4100/api/v1/me

# the flagship scenario — returns immediately with a runId
curl -X POST localhost:4100/api/v1/runs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"objective":"Generate infrastructure leads"}'

# watch it
curl -H "Authorization: Bearer $TOKEN" localhost:4100/api/v1/runs/<runId>
curl -H "Authorization: Bearer $TOKEN" localhost:4100/api/v1/runs/<runId>/trace

# gate 1: read what you are approving, then echo its hash back
curl -H "Authorization: Bearer $TOKEN" localhost:4100/api/v1/approvals?status=pending
curl -H "Authorization: Bearer $TOKEN" localhost:4100/api/v1/approvals/<id>
curl -X POST localhost:4100/api/v1/approvals/<id>/approve \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"payloadHash":"<the payloadHash from the GET>"}'

# the deliverable
curl -H "Authorization: Bearer $TOKEN" localhost:4100/api/v1/campaigns/<id>/package
```

### Before the first real run

Feed the knowledge base. **RAG with an empty corpus generates confident
fiction**, which is worse than generating nothing — so the run output reports
`brandRulesEnforced: false` when there is nothing to check against.

```bash
curl -X POST localhost:4100/api/v1/knowledge/documents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"corpusType":"product_service","title":"Service lines","content":"..."}'
```

Corpus coverage is visible at `GET /api/v1/knowledge/documents`.

---

## Moving to real data

Everything validated so far used the SYNTHETIC fixtures in `fixtures/knowledge/`.
They describe a fictional company and must not reach a real campaign.

### 1. Verify the CRM connection

```bash
npm run verify:crm
```

Exercises every `CrmPort` method against the live NXT Sales API and reports each
one separately. Read-only by construction — `CrmPort` has no write methods.
It checks preconditions first (shared `JWT_SECRET`, CRM reachable, service user
set) and stops at the first unmet one with the exact fix.

### 2. Replace synthetic knowledge with real documents

```bash
npm run purge:fixtures -- --dry     # list what would go
npm run purge:fixtures              # remove the synthetic set
```

Only documents whose titles carry the fixture markers are removed; real
documents are never touched. Purge BEFORE ingesting real material — mixed
corpora produce packages that cite invented figures alongside real ones and look
authoritative while being partly fabricated.

```bash
npm run ingest:doc -- <corpusType> <path> ["Optional Title"]
```

Accepts **plain text and markdown only**. Binary formats are refused rather than
ingested as garbage. Max `KNOWLEDGE_MAX_UPLOAD_CHARS` (400,000) per document.

Recommended order — each one changes what the next step can do:

| # | corpusType | Why this order |
|---|---|---|
| 1 | `brand_guidelines` | Until this exists the validator enforces nothing and reports `brandRulesEnforced: false` |
| 2 | `product_service` | Without it, content cannot describe what is actually sold |
| 3 | `company_info` | Positioning and differentiators |
| 4 | `persona` | Sharpens targeting; ICP evidence still comes from CRM deals |
| 5 | `case_study` | The ONLY thing that licenses a quantified claim |
| 6 | `marketing_content` | House style for the generator to imitate |
| — | `past_campaign` | Optional. Accumulates as the platform runs |

### 3. Check retrieval against the real corpus

```bash
npm run report:retrieval
```

Prints cosine similarity alongside the fused API result. **Re-tune
`KNOWLEDGE_MIN_COSINE` from this output** — the default (0.55) was measured
against the synthetic corpus, where relevant queries scored 0.587-0.675 and
irrelevant ones peaked at 0.514. A real corpus will sit differently.

---

## Roles

Marketing roles live here, in `TenantMember` — deliberately **not** derived from
NXT Sales' `User.role`. A CRM admin is not automatically someone who may sign
off a campaign.

| Role | view | operate | approve | admin |
|---|:--:|:--:|:--:|:--:|
| `viewer` | ✅ | | | |
| `operator` | ✅ | ✅ | | |
| `approver` | ✅ | | ✅ | |
| `admin` | ✅ | ✅ | ✅ | ✅ |

`approve` is separate from `operate` on purpose, and `ALLOW_SELF_APPROVAL` is
`false` by default: whoever ran the campaign should not be the one signing it off.

Grant a role: `POST /api/v1/admin/members`.

---

## Testing

```bash
npm test          # 63 unit tests — no network, no API key, no database
npm run typecheck
```

The e2e suite (`tests/e2e/`) needs a migrated database with pgvector and
**skips with a printed reason** when one is not reachable, rather than passing
hollowly. **Stop the worker before running it** — the suite drives the run loop
itself, and a live worker consuming the same queue will race it. It runs the whole pipeline against the fake CRM and fake LLM but a
real database and real queue — resumability and the audience snapshot are
properties of persistence, so mocking the store would skip the part that matters.

The fakes validate their canned payloads against the real zod schemas, so a
schema change the fixtures do not follow fails the suite.

---

## Layout

```
prisma/                schema + migrations + seed
sql/                   extension and index DDL Prisma cannot express
scripts/apply-sql.mjs  cross-platform .sql runner (no psql on PATH required)
src/
  config/env.ts        boot validation — fails fast, no fallbacks
  platform/            db · queue (pg-boss) · logger · audit · errors
  crm/                 CrmPort interface + NXT Sales adapter + fake
  llm/                 Gemini gateway · prompt store · token ledger · cost
  knowledge/           chunker · pgvector store · hybrid retriever · ingest
  research/            SSRF guards · page fetch · html→text (ported)
  campaign/            ICP deriver · audience resolver · suppression · validators
  approval/            payload hashing + the two gates
  orchestrator/        state machine · runner · tool registry · dispatcher · steps
  api/                 middleware + routes
```

### Ported from NXT Sales, deliberately

| What | From | Why |
|---|---|---|
| SSRF guards | `routes/intelligence.js` | Genuinely well built. A weaker second copy would be a vulnerability |
| HTML→text + 14 CMS fingerprints | `routes/intelligence.js` | Includes two fixed bugs (entity-decode order, the Magento lookbehind) |
| Model fallback ordering | `utils/geminiModel.js` | Encodes a verified finding: pinned model names 404 for newer keys while still being advertised |
| Cost estimation | `utils/aiPricing.js` | Including its "never invent a rate" discipline |
| Honest token accounting | `AiUsage` | Provider-reported only, `hasUsageData: false` when absent |
| Versioned DB prompts | `PromptTemplate` | Including `isSystem` protection |

### Deliberately NOT reused

Browser-side LLM calls with a `localStorage` key; client-reported usage
telemetry; `setInterval` background work; `updateMany` as an authorization check.

---

## Open items

| Item | Status |
|---|---|
| `pgvector` not installed | ❌ **Blocks the knowledge base.** Install against PG 18 |
| `nxt_marketwiz` database absent here | ❌ Blocks any real CRM read |
| Marketing knowledge corpus | ❌ Business input. Nothing to retrieve until it exists |
| What "infrastructure" means in the Industry dropdown | ❌ Business input |
| Web search provider | `SEARCH_API_PROVIDER=none` — RESEARCH degrades to page fetches and says so |
| NXT Sales RBAC (Phase 0) | ❌ Outstanding. The service account is over-privileged until then |
| PDF/DOCX ingestion | Text and markdown only for now |
| `gemini-pro-latest` pricing | Resolves to `gemini-3.1-pro-preview`, which has no published rate — reported as `priced: false` rather than guessed |
