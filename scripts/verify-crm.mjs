import { readFileSync } from 'node:fs'
import 'dotenv/config'
import jwt from 'jsonwebtoken'

// Verifies the REAL NXT Sales REST connection, method by method.
//
// This is the tool to run the moment nxt_marketwiz is restored and the CRM is
// running. It exercises every method on CrmPort against the live API and
// reports each one individually, so a failure points at the endpoint that broke
// rather than at "the CRM adapter".
//
// It is READ-ONLY BY CONSTRUCTION: CrmPort has no write methods in Phase 1, so
// there is nothing here that could modify NXT Sales data even by mistake.
//
// Preconditions are checked BEFORE importing config/env.ts, because that module
// exits the process on invalid config — which would hide the actual diagnosis.

const BASE = process.env.NXT_SALES_BASE_URL ?? 'http://localhost:4000'
const SERVICE_USER = process.env.NXT_SALES_SERVICE_USER_ID ?? ''
const SECRET = process.env.JWT_SECRET ?? ''

const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

console.log('NXT Sales connectivity check')
console.log('='.repeat(70))
console.log(`base url          : ${BASE}`)
console.log(`service user id   : ${SERVICE_USER || '(NOT SET)'}`)
console.log(`JWT secret        : ${SECRET ? `set (${SECRET.length} chars)` : '(NOT SET)'}`)

// ── Precondition 1: shared signing secret ──────────────────────────────────
if (!SECRET) fail('JWT_SECRET is not set in marketing-agent/.env')

// It must match NXT Sales byte for byte, or every token this service mints is
// rejected. Compare against the CRM's own .env when it is readable locally.
try {
  const crmEnv = readFileSync(new URL('../../project/server/.env', import.meta.url), 'utf8')
  const crmSecret = crmEnv.match(/^JWT_SECRET="?([^"\r\n]+)/m)?.[1]
  if (crmSecret) {
    console.log(`secret matches CRM: ${crmSecret === SECRET ? 'YES' : 'NO — tokens will be rejected'}`)
    if (crmSecret !== SECRET) fail('JWT_SECRET does not match project/server/.env')
  }
} catch {
  console.log('secret matches CRM: (project/server/.env not readable from here — skipped)')
}

// ── Precondition 2: the CRM is actually up ─────────────────────────────────
let health
try {
  const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(5000) })
  health = await res.json()
  console.log(`health            : ${res.status} ${JSON.stringify(health)}`)
} catch (err) {
  fail(
    `NXT Sales is not reachable at ${BASE}\n  ${err.message}\n\n` +
      `  Start it with:  cd ../project && npm run dev:server\n` +
      `  It cannot start until its database (nxt_marketwiz) exists.`,
  )
}

// ── Precondition 3: a service-account user id ──────────────────────────────
if (!SERVICE_USER) {
  fail(
    'NXT_SALES_SERVICE_USER_ID is not set.\n\n' +
      '  This service authenticates as a real NXT Sales User row. Pick one and\n' +
      '  put its id in marketing-agent/.env:\n\n' +
      `    SELECT id, email, role FROM "User" WHERE status = 'active' ORDER BY "createdAt" LIMIT 5;`,
  )
}

// ── Method-by-method verification ──────────────────────────────────────────
process.env.CRM_DRIVER = 'real'
const { getCrm } = await import('../dist/crm/index.js')
const crm = getCrm()

console.log(`\nadapter           : ${crm.name}`)
console.log('='.repeat(70))

const results = []

async function check(name, fn, describe) {
  const started = Date.now()
  try {
    const out = await fn()
    const ms = Date.now() - started
    results.push({ name, ok: true })
    console.log(`  PASS  ${name.padEnd(22)} ${String(ms + 'ms').padEnd(8)} ${describe(out)}`)
    return out
  } catch (err) {
    results.push({ name, ok: false, error: err.message })
    console.log(`  FAIL  ${name.padEnd(22)} ${'-'.padEnd(8)} ${err.message}`)
    return null
  }
}

const n = (x) => (Array.isArray(x) ? `${x.length} rows` : x == null ? 'null' : 'ok')

await check('health', () => crm.health(), (o) => (o.ok ? 'ok' : `NOT OK: ${o.detail}`))
await check('listUsers', () => crm.listUsers(), n)
await check('getDropdownFields', () => crm.getDropdownFields(), n)

const industries = await check(
  'getDropdownOptions',
  () => crm.getDropdownOptions('company.industry'),
  (o) => `${o.length} industry values`,
)
await check('getCustomFieldDefs', () => crm.getCustomFieldDefs('Company'), n)

const companies = await check(
  'searchCompanies',
  () => crm.searchCompanies({ limit: 5 }),
  (o) => `${o.items.length} of ${o.total} total`,
)

// The array-encoding quirk that fails SILENTLY: `industries` must go out as a
// repeated param, never comma-joined. If this returns 0 while the unfiltered
// search returned rows, the encoding is wrong, not the data.
if (industries?.length) {
  await check(
    'searchCompanies+filter',
    () => crm.searchCompanies({ industries: [industries[0].value], limit: 5 }),
    (o) => `${o.total} match industry "${industries[0].value}"`,
  )
}

await check('exportCompanies', () => crm.exportCompanies({ limit: 1 }), (o) => `${o.items.length} rows (unpaginated)`)

if (companies?.items?.length) {
  const id = companies.items[0].id
  await check('getCompany', () => crm.getCompany(id), (o) => (o ? `"${o.name}"` : 'null'))
  await check('listActivities', () => crm.listActivities({ companyId: id, type: 'email' }), n)
  await check('getEmailSummary', () => crm.getEmailSummary(id), (o) => `${o.threadCount} threads`)
} else {
  console.log('  SKIP  company-scoped methods    no companies returned')
}

await check('listDeals', () => crm.listDeals(), n)
const deals = await check('exportDeals', () => crm.exportDeals(), n)
const stats = await check(
  'getDealStats',
  () => crm.getDealStats(),
  (o) => `${o.totalDeals} deals, ${o.wonDeals}W/${o.lostDeals}L, ${o.dealsWithoutCompany} unlinked`,
)

// ── Readiness for a real ICP ───────────────────────────────────────────────
console.log('\n' + '='.repeat(70))
const failed = results.filter((r) => !r.ok)
console.log(`${results.length - failed.length}/${results.length} methods passed`)

if (deals && stats) {
  // Runs the REAL deriver rather than a reimplementation, so this reports what
  // the ICP step would actually see.
  //
  // A raw count of decided deals is the wrong test, and an earlier version of
  // this check used one. icpDeriver drops any FACET with fewer than 3 decided
  // deals, so 17 decided deals spread across 20+ industries survives a
  // "decided >= 10" test while yielding zero usable facets.
  const { deriveIcpEvidence } = await import('../dist/campaign/icpDeriver.js')
  const ev = await deriveIcpEvidence(crm)

  console.log('\nICP data readiness (via the real icpDeriver):')
  console.log(`  deals analysed        : ${ev.totalDeals} (${ev.wonDeals}W / ${ev.lostDeals}L)`)
  console.log(`  deals with no company : ${ev.dealsWithoutCompany} — excluded from every facet`)
  console.log(`  companies analysed    : ${ev.companiesAnalysed}`)
  console.log(
    `  surviving facets      : industry=${ev.byIndustry.length}  country=${ev.byCountry.length}  cms=${ev.byCms.length}`,
  )

  if (ev.byIndustry.length === 0) {
    console.log('')
    console.log('  BLOCKER: no industry facet has >=3 decided (won+lost) deals.')
    console.log('           The ICP step would run with no firmographic evidence and')
    console.log('           produce a profile grounded in nothing. An ICP generated in')
    console.log('           this state must not be treated as a real finding.')
  } else {
    console.log('\n  top industries by win rate:')
    ev.byIndustry
      .slice(0, 5)
      .forEach((f) =>
        console.log(`    ${f.value.slice(0, 44).padEnd(46)} ${f.won}W/${f.lost}L = ${(f.winRate * 100).toFixed(0)}%`),
      )
  }
}

if (failed.length) {
  console.log('\nfailures:')
  failed.forEach((f) => console.log(`  ${f.name}: ${f.error}`))
  process.exit(1)
}
console.log('\nAll CrmPort methods verified against the live NXT Sales API.')
