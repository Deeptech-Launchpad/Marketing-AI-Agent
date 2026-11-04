# Warm Leads — operations runbook (permanent module)

Status: **built and tested locally; NOT deployed.** Nothing in this file has been run on the server.
Every step below needs the owner's separate approval before it is executed.

## What it is

Every NXT Sales company is evaluated as **warm / early signal / cold / not enough data** (plus the
separate statuses existing customer, active opportunity, do not contact):

1. **Screen (cheap, every company):** the CRM record (deals, replies, do-not-contact) and the company
   website. No Gemini.
2. **Deep research (Gemini, only for promising companies):** companies whose screen shows a first sign
   (a replied email, or a product-data fit on a readable website). Bounded by the daily Gemini ceiling.
3. **The rule** (`src/warmleads/score.ts`): Warm = score ≥ 50 **and** a verified intent signal;
   Early Signal = 25–49 **and** a fresh verified signal. Incomplete research is never Cold.

Results live only in the Marketing database (`WarmLead*` tables) until sending to NXT Sales is approved.

## Processes

| PM2 app | Entry | Does |
|---|---|---|
| `nxt-marketing-api` | `dist/index.js` | serves the screen (`/api/warm-leads/*`; page **Warm Leads** in the left rail, `/warm-leads`); reads the DB, writes settings; **never calls NXT Sales or Gemini** for Warm Leads |
| `nxt-marketing-worker` | `dist/worker.js` | unchanged; **no Warm Leads code or queue any more** |
| `nxt-marketing-warmleads` | `dist/warmleadsWorker.js` | the only process that evaluates; own memory ceiling (1200 MB / `--max-old-space-size=1024`); no job queue; read-only CRM; every Gemini call must be reserved in the DB |

`ops/marketing-watchdog.sh` touches only the API and the main worker, so a Warm Leads problem can never
restart them.

## Switches (all default OFF)

| Where | Switch | Effect when off |
|---|---|---|
| `.env` | `WARM_LEADS_WORKER_ENABLED` | the worker starts and idles; the screen refuses "Start" |
| screen | Start / Pause (default **paused**) | nothing is evaluated |
| screen | pilot approval | daily processing is refused |
| `.env` | `WARM_LEADS_SYNC_ENABLED` (+ `WARM_LEADS_ALLOW_LIVE` for a non-local CRM) | nothing is sent to NXT Sales |
| screen | "Approve sending to NXT Sales" | nothing is sent to NXT Sales |

## Limits (enforced in the database, atomically)

| | Pilot | Start | After your review |
|---|---|---|---|
| companies | 100 total | 25 / night | 50 / night |
| Gemini calls | 1,200 total | 300 / night | 600 / night |

There is **no 100-companies-a-day tier** (owner's decision, 2026-11-04). It is not in the code or on the screen; it needs a separate approval and a code change.

Window: 23:00–06:00 Asia/Kolkata (admin-configurable). A night that crosses midnight is one night.
Retries get at most 20 % of a night's companies. Memory: a night starts only with ≥ 4 GB available and
stops below 3 GB (`WARM_LEADS_MIN_AVAILABLE_MB`). One company at a time; DB pool is the shared default
unless `connection_limit` is set in `MARKETING_DATABASE_URL` for the worker.

## Migration

`prisma/migrations/20261104100000_warm_leads_permanent` — **additive only**: 3 new tables
(`WarmLeadSettings`, `WarmLeadCompany`, `WarmLeadUsage`) and 5 new nullable/defaulted columns on two Warm
Leads tables. It follows `20261030120000_warm_lead_evaluation` and `20261031100000_warm_lead_sample`,
which are not deployed either, so **three** migrations will be pending on the first deploy. No existing
table of another feature is touched.

## Proposed rollout (each step needs approval)

0. Local development and tests — **done**.
1. **Deploy with everything off.** Fresh DB backup → pause the watchdog → `git` fast-forward only →
   `npm ci` → `prisma migrate deploy` (exactly the three pending migrations) → `prisma generate` →
   `npm run build` (+ web build) → `pm2 restart nxt-marketing-api nxt-marketing-worker` and
   `pm2 start ecosystem.config.cjs --only nxt-marketing-warmleads` → restore the watchdog → verify Bulk
   Email, login, Gmail, health. `WARM_LEADS_WORKER_ENABLED=false` at this point.
2. Set `WARM_LEADS_WORKER_ENABLED=true`, restart only `nxt-marketing-warmleads`. On the screen: read the
   company list (read-only), prepare the pilot, press Start. It runs inside the window.
3. Review the 100 results on the screen; approve (or send back).
4. Daily mode at 25 companies / 300 calls. Review usage and accuracy; approve 50 / 600. Nothing above that without a new approval.
5. NXT Sales: deploy the NXT Sales change (one new service-only `DELETE` route; its own approval and its
   own rules — never without approval), then set `WARM_LEADS_SYNC_ENABLED=true` and approve sending on the
   screen.

## Rollback

| Problem | Action | Data |
|---|---|---|
| anything odd while running | press **Pause** (stops before the next company) | kept |
| runaway cost / load | `WARM_LEADS_WORKER_ENABLED=false` + `pm2 stop nxt-marketing-warmleads` | kept |
| Warm Leads must be removed | `pm2 delete nxt-marketing-warmleads`; revert the code; leave the tables (unused, harmless) | kept; drop later only on request |
| NXT Sales shows wrong rows | switch sending off on the screen; the withdrawal call removes listed rows | Marketing keeps full history |
| bad deploy of the shared code | `git` revert to the previous commit, rebuild, restart API + main worker; restore the backup only if a migration must be undone (it is additive, so normally it need not be) | — |

## Watching it

`pm2 logs nxt-marketing-warmleads`; the screen's **Usage** panel (per night: companies, Gemini calls vs
ceiling, priced cost, calls without a price, why the night stopped); `WarmLeadUsage` rows.

## Tests

Backend unit: `npm test` (all pass; on a laptop whose temp drive has < 5 GB free the 39 ZIP tests in
`bulkEmail.test.ts` fail on the free-disk guard — not a code problem). Web: `cd web && npm test`.
Database integration (needs Postgres with the new migration):
`npx vitest run tests/integration/warmLeadsPersistence.test.ts --pool=forks --poolOptions.forks.singleFork=true`
— **13/13 passed on 2026-11-04 on the isolated server database `marketing_warmtest`** (never on the laptop,
never on production). The production deployment procedure is kept with the maintainers (it holds server details).
