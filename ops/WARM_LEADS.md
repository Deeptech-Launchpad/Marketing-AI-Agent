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
| `.env` | `WARM_LEADS_GEMINI_API_KEY` | Warm Leads' own Gemini key (separate Google Cloud project). Empty or equal to `GEMINI_API_KEY` = Warm Leads stays idle and the screen says so; the shared key is never used for it. All other features keep `GEMINI_API_KEY` |
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

## Rules the classifier follows (score.ts, replies.ts) — verified by tests

- **Warm** = score >= 50 AND at least one verified intent signal. **Early signal** = score 25-49 AND a verified, *fresh* intent
  signal. **Cold** = research finished (or a website was read) and nothing current. Not-enough-data, Failed / retry, Existing
  customer, Active opportunity and Do not contact are separate statuses and are never shown as Cold.
- Intent is only an *event* (a reply a person wrote; a business/news event with a source address that can be checked). A shop,
  a platform, a product catalogue or a technology change is **fit**: it earns at most 20 points in total (10 for the site, one
  block of 10 for platform detections however many are recorded) and can never qualify a company.
- **Duplicate evidence counts once** (positive AND negative news). Two records are one event when they are the same page on the
  same day (or one undated) of the same kind in similar words naming no different fact, or the same kind of news on another page
  within 7 days in nearly the same words naming the same facts. Words are compared in any language (Unicode; two-character groups
  for scripts written without spaces) after light stemming (opens / opened / opening), so a changed verb form or extra detail
  ("Acme Corp ... Pune, India" / "Acme ... Pune, Maharashtra") is the same event. A different number, or a different name in the
  same place of the sentence ("in Pune" / "in Delhi", "with Acme" / "with Globex"), is a different development. A page address
  that differs in a parameter that identifies the article (`news.aspx?id=101` / `?id=102`) is a different page; tracking
  parameters are ignored. The best copy scores; the rest are listed with 0 points and say "counted once". Scores are worked out
  afresh from the evidence every time, so re-evaluating never adds up. **Known limits:** the same story in clearly different
  words (a synonym for the verb, another outlet's own phrasing) is still counted twice; text with no capital letters, and scripts
  without capitals, can only be told apart by their numbers, so two real developments in such text can be merged (an under-count).
- **Intent and permission to contact are separate.** A reply counts as interest only if what the person wrote is read, says
  something, and refuses nothing. The subject AND the text of the message (already returned by the authorised
  `GET /api/activities?type=email`; quoted earlier messages, signatures and footers are cut off first, by line, so a dash, a ">" or
  "regards" inside a sentence is not a boundary) are checked. The kind of answer is recorded, never the words:
  `reply_opt_out` (unsubscribe, stop, remove me, do not email), `reply_declined` (not interested, not required, we will pass),
  `reply_declined_product` (not interested in ONE product), `reply_wrong_contact`, `reply_declined_meeting`, and
  `reply_unverified` (no text, nothing of the person's own, or too short to tell: "Ok", "Thanks"). All score 0 and are never
  intent. The newest message decides; two messages with the same time are decided by the more cautious. An out-of-office text under
  a normal subject is automated mail. English, plus common Hindi/Hinglish, French, German, Spanish and Portuguese phrases; a refusal
  in another language is missed: a SHORT (six words or fewer) non-English reply is `reply_unverified`, but a longer one outside the listed
  phrases can be read as interest (no refusal, no hold) - a known limit.
- **HUMAN REVIEW REQUIRED.** If a company's independent signals (news, platform change, fit) would make it Warm or an Early Signal
  but its newest reply is an opt-out or a "not interested", it is classified `human_review`: shown with its score and reasons,
  never listed as an actionable lead, not sent to NXT Sales (a company already listed is withdrawn). A rejection of one product, a
  wrong-person answer or a declined meeting does not disqualify independent demand. A company the CRM lists as do-not-contact stays
  `do_not_contact`. The module can record an explicit marketing opt-out on the suppression list - see the next point; that is off by default.
- **Privacy.** The email text is read in memory only: it is never stored, logged, sent to Gemini or copied into a result or to NXT
  Sales; no customer phrase and not even the subject of a refusing reply is kept - only the kind, the date and the fact that an
  inbound email exists. The mapper reads the text only for an inbound email inside the 90-day window, cuts the raw text to 60,000
  characters before any pattern runs, removes style / script / head / comments, decodes entities, and keeps 6,000 characters.
- **Marketing opt-outs (decisions of 2026-11-05 and 2026-11-06).** Buying intent and permission to contact are separate. An explicit
  opt-out withdraws *marketing* permission; "not interested", a rejection of one product, a wrong-person answer or a declined meeting never
  do. The shared suppression list (`SuppressionEntry`) is what the sending gates already check, so recording an address there is all it
  takes; **no Bulk Email code changes.**
  - **What is recorded automatically - only a STRICT, STANDALONE, individual opt-out:** "UNSUBSCRIBE", "STOP", "REMOVE ME [FROM YOUR MAILING
    LIST]", "DO NOT EMAIL ME", "PLEASE STOP SENDING ME MARKETING EMAILS" and nothing else in the message (greetings, thanks and a signature
    do not count as something else). **Not recorded - held for a person, with no suppression write:** a message that also asks for a
    quotation or information, mentions another or an old address, a colleague, or "us"; mixes the phrase with other instructions; or is an
    opt-out only in the subject or in quoted text. Such a message is still an opt-out for the hold below, and is listed as "not recorded
    automatically" with its NXT Sales activity. Every English, Hinglish and listed-language wording of "do not send further emails" is a refusal and never buying intent.
  - **Which address:** only the single, unambiguous sender (`fromEmail`) of that message: one whole, plain, lower-case address, written as one
    `email` row (global, `source: unsubscribe`, no expiry, tenant-scoped). The header is parsed token by token; if anything in it is not a plain
    address (an apostrophe or `&` in the name, a non-ASCII letter, a quoted part, a very long header) **nothing is suppressed** - an address is
    never "repaired" into a different one. The address is validated again at the writer. Refused: several or no sender, our own mailbox / the
    CRM user / the inbound `toEmail` / **any address on one of our own domains** (colleagues) / a plus-alias / no-reply, postmaster,
    mailer-daemon, bounce, alert or system addresses, and any message whose own mailbox is unknown. The address we mailed on the conversation
    (`matchedCompanyEmail`), when different, is shown as a masked SUGGESTION and is never suppressed. Never a domain row, a company row, or a
    second address. The `From` header is not authenticated by NXT Sales: a forged "unsubscribe" could name a third party's address - one
    more reason the switch stays off until the pilot's dry-run proposals have been read.
  - **The sender of an email is NOT authenticated - so NOTHING email-derived is ever written automatically (fail closed; owner decision of
    2026-11-10).** Checked 2026-11-06: NXT Sales stores the raw `From` header (as Gmail delivered it) and nothing about SPF, DKIM, DMARC or ARC -
    no such value is read, stored or returned, and "inbound" only means the `From` address is not the synced mailbox. A forged "unsubscribe"
    naming a third party's address therefore cannot be told from a real one, and anything an email says about itself (a header-looking line in its
    text, an extra field) counts for nothing. **There is no automatic-write code at all** - no "verified sender" flag, no worker path: the
    evaluation only stores a PROPOSAL (a test scans the source for any trace of one). **With the switch on, an ADMINISTRATOR approves each
    individual proposal** (`POST /api/warm-leads/opt-outs/approve`, admin only, enforced on the server). The approval screen shows the company and
    its current classification, the masked address, the NXT Sales activity id and date, the warning **SENDER NOT AUTHENTICATED**, a warning for an
    existing customer / active opportunity / do-not-contact company, and the exact reason the proposal was generated (the standard phrase, by our
    own label, e.g. "UNSUBSCRIBE" - never the customer's words). The administrator must tick an explicit confirmation that **the request was verified
    independently through a trusted contact channel** - reading the (unverified) email itself is not verification. The request carries the two ids
    and that confirmation, and never an address: the server checks that the proposal is a stored one of the caller's tenant, re-reads that one email
    from NXT Sales (read only), works the address out AGAIN from it by the strict rules, and refuses if the email is no longer a plain standalone
    opt-out from one safe sender, if its sender is no longer EXACTLY the address that was proposed (compared by a keyed fingerprint stored with
    the proposal - a mask would let a similar address through; a proposal stored without one cannot be approved), or if the CRM returns the email for
    another company (or the email is older than 90 days - add the address by hand in the suppression list screen). It then writes the one row naming
    the approver (`createdByCrmUserId`) **and its audit entry in ONE database transaction**: if the audit entry cannot be written, the row is rolled
    back too ("no record, no change"). The audit entry holds the masked address, the activity id, the company's classification and the recorded
    confirmation - never the address. A trustworthy stored authentication result would have to be added to NXT Sales' data first - a separate,
    reviewed change - before even a design for recording without a person could be considered.
  - **The switch `WARM_LEADS_RECORD_OPT_OUTS` is OFF by default** and stays off for development and the first 100-company pilot (the
    readiness check fails if it is on before the pilot is approved). Off = dry run: each evaluation stores a line like `r***@acme.example
    (the sender of the opt-out of 2026-11-03) is PROPOSED for the suppression list — DRY RUN: nothing was written`, with
    `status: dry_run · NXT activity <id> · received <date> · fp <keyed fingerprint> · phrase: UNSUBSCRIBE`, and nothing can be approved. With it
    on, the same line reads `is NOT added yet: the sender of an email cannot be verified, so a person must approve it first` (`awaiting_approval`).
    **Turning the switch on never bypasses individual approval - it only makes approval possible.** Turning it on needs the owner's separate
    approval. `src/warmleads/optOut.ts` is the only code that writes (a test scans the source for any other writer, and for any delete or edit);
    `writeApprovedOptOut` is called only from the approval module, which only the admin route calls and the worker cannot reach.
  - **Dry-run evidence is kept and reviewable, and nothing is silently left out.** The lines live in the stored reasons of the evaluation (masked
    address, day, status, NXT activity id - never a raw address or message text), also on an evaluation that FAILED (site unreadable) and across
    later re-checks. The pilot review shows them in one list ("Opt-outs found in replies", `GET /api/warm-leads/pilot/opt-outs`, tenant-scoped, same
    permission as the pilot results), still there after the email has left the 90-day window. The evaluations are read in batches until there are no
    more (no 1,000-row cut-off); the list shows the **total number of pending proposals** and, only if a backstop ceiling is ever reached, says in
    red that the list is NOT complete. The screen pages 25 at a time. The activity id is a CRM id, not personal data; the email is opened in NXT
    Sales under NXT Sales' own access rules - Marketing does not open it.
  - **Failure-safe, atomic and idempotent writes.** Each approval is its own transaction. A stored line says "added" only after the transaction
    committed. An approval that fails (database error, or the audit entry could not be written) is reported to the administrator as a failure and
    writes nothing. Approving again is idempotent: exactly one row, then "already on the list". An existing entry that is *temporary* or has
    *expired* is never revived and never reported as a success - it is listed for a person.
  - **Durable and never lifted by automation.** The row has no expiry, so the opt-out outlives the 90-day window. Each evaluation looks up the
    company's addresses (saved addresses, parsed, and senders of recent mail, ignoring case). An acknowledgement, a quote request, a product
    enquiry or a friendly reply does not restore consent. Only clear, affirmative wording ("please subscribe me again", "add us back to your
    list") creates a `reconsent_candidate` line for a person; **a person removes the row** (`DELETE /admin/suppression/:id`). Company or domain
    do-not-contact stays a hard restriction (`do_not_contact`) whatever anyone writes: no individual reply, approval or re-consent candidate can
    override it (it is decided first in the classification, and the audience matcher excludes the whole company for a company or domain row).
    Match limit: Warm Leads' own do-not-contact check compares the company's `domain` field exactly (trimmed, lower-case; no `www.` / scheme
    clean-up) and does not look at the domain of a contact's address; the sending gates and the audience matcher normalise further and still block.
  - **Which existing rows hold a company in `human_review`:** automatically recorded opt-outs (`source: unsubscribe`) and manual rows whose own
    reason says the person opted out. Imported, policy, wrong-person and campaign-specific rows do not; every valid row is still enforced by the
    sending gates. A company with such an opted-out contact that would otherwise be Warm or an Early Signal is `human_review`: a later
    enquiry still earns its buying-intent points, but a person decides, and nothing is listed or sent to NXT Sales for it. A refusal seen by an
    evaluation that could not finish (site unreadable, research cut short) also turns a kept Warm / Early Signal into `human_review`.
  - **What an `email` suppression row blocks - read this before enabling the switch.**
    - Bulk Email (review, start and the moment of sending, for the **To** address; also "Send to one person"), the outreach engine, and the sales
      sequence all check the exact destination address through `checkSuppression()`. Only an email to **that address** is blocked. CC copies are
      checked only for a company's colleagues at a bulk review; **CC addresses typed into "Send to one person" or set on a sender profile are not
      suppression-checked** (existing Bulk Email behaviour, unchanged).
    - The sales sequence also blocks its **reply stages** - the emails it sends in answer to the prospect's own reply - to that address; the open-deal
      check is the only thing skipped for them.
    - LinkedIn, call and WhatsApp actions to the same person are **not** blocked by an email row (the code comment saying "every channel" is
      about the gate, which matches the destination).
    - Campaign **audiences** are person-level since 2026-11-06: an email row removes that address from a company's contacts and the company
      stays while any saved address remains; a company or domain row still excludes the whole company.
    - **A person can still answer a customer directly.** Emails that reps write and send by hand inside NXT Sales are not covered (checked:
      NXT Sales' send route has no suppression check, and has no suppression list at all), so an opted-out contact who later asks for a quote can
      be answered by a human there. The suppression list is about **marketing** from this platform; it is not a verdict on ordinary conversation.
      The reverse also holds: answering an enquiry, or the enquiry itself, never restores marketing consent - that needs clear affirmative wording
      and a person (see below). Platform-sent replies to that address (the sales sequence's reply stages) are blocked, so a human answers instead. The match is exact and lower-case, as in Bulk
      Email's own unsubscribe (`a.b@gmail.com` and `ab@gmail.com` differ). The mapper gives sender addresses only under the same opt-in as the
      email text (inbound, within 90 days); a full address is never logged or put in a result - only a masked form.
  - **Known limits:** phrase matching can miss an opt-out in unusual wording or another language (it then looks like interest or
    `unverified`); at most 10 senders per company are proposed in one evaluation (the address we actually mailed first, then the newest; the
    rest are listed "not recorded" for a person), and a message dated in the future or with text beyond the first 60,000 characters is not read
    as a standalone opt-out; the approval needs the email to be inside the 90-day window; meeting cancellations are recognised only in calendar-system wording ("Declined:", "has declined this invitation"), not
    in a person's own words; a row of any other source on one of a company's addresses is enforced but does not by itself hold the company.
- **NXT Sales run summary.** NXT Sales has no field for `human_review` and is not changed: companies held for review are not counted as
  `processed` in the summary sent there, so its categories add up. The count stays on the Marketing screens.
- A failed, unreadable or incomplete evaluation never replaces a company's current result: Warm / Early signal stay, marked
  "re-check due". Incomplete research (Gemini ceiling or cap) is never Cold.
- Existing customers, open deals and suppression-list companies are recognised first and their websites are never read.

## Is the pilot ready to be requested? (read-only check)

`npx tsx scripts/warmleads-pilot-readiness.ts [--tenant <id>]` prints PASS / FAIL / INFO for the database (reachable, tables), the tenant (several tenants need --tenant; an unknown one fails; **a tenant that has not completed Warm Leads setup - no settings row yet - fails too: nothing was checked for it, so it is never READY**), the real model driver, the dedicated
Gemini key, sending off, live-write off, paused, the 100 / 1,200 and 25 / 300 limits, the size of the NXT Sales list (one GET),
memory and the window. No Gemini call, no write, nothing requested or started. Exit 0 = ready, 1 = something stands in the way.

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
Database integration (needs Postgres 16 with pgvector and all migrations; a disposable local one is
`docker run -d -e POSTGRES_PASSWORD=... -e POSTGRES_DB=marketing_agent_dev -p 127.0.0.1:5434:5432 pgvector/pgvector:pg16`,
then `CREATE EXTENSION vector SCHEMA marketing` and `npx prisma migrate deploy`):
`TEST_USE_REAL=1 npx vitest run tests/integration/warmLeadsPersistence.test.ts tests/integration/warmLeadsWorkflow.test.ts --pool=forks --poolOptions.forks.singleFork=true`
— `warmLeadsWorkflow` runs the whole thing (list -> pilot -> worker cycles -> screening, research, scoring -> stored results,
counts, approval, a failed re-check, the Gemini ceiling) with a fake CRM, website and research, and the real database,
scheduler, scoring and call budget.
— **The last full run on the isolated SERVER database `marketing_warmtest` was 13/13 on 2026-11-04**, before the permanent opt-out, human-review and sync-guard
tests existed. The current suites (19 workflow + 17 persistence tests) have run **only on the disposable local database** (2026-11-06); they have
not yet run on the isolated server database. The production deployment procedure is kept with the maintainers (it holds server details).
