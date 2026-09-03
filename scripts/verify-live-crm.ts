import 'dotenv/config'
import jwt from 'jsonwebtoken'

// LIVE NXT SALES — READ-ONLY CONNECTIVITY VERIFICATION.
//
// Run this once a live service credential is available, to confirm the
// marketing agent can reach and read the live CRM. It answers four questions
// and changes nothing.
//
// ─────────────────────────────────────────────────────────────────────────
// WHY THIS IS A SEPARATE SCRIPT
//
// Repointing NXT_SALES_BASE_URL in .env would send the whole platform at the
// live CRM — every engine, every background job — and the local signing secret
// is rejected there, so everything would start returning 401. This script
// takes the live host and credential from its OWN variables, so verifying live
// access cannot disturb a working local setup.
//
// ─────────────────────────────────────────────────────────────────────────
// SAFETY
//
//   · Every request is GET. There is no code path here that can write.
//   · It refuses to run if CRM_WRITE_ENABLED is on, so a live verification
//     can never coincide with an enabled write path.
//   · No secret is printed. The token is minted, used, and never logged; the
//     URL is shown with any credential stripped.
//
// Usage (values supplied at the command line, never committed):
//
//   LIVE_NXT_SALES_BASE_URL=https://nxtsales.altiusnxt.tech \
//   LIVE_NXT_SALES_JWT_SECRET=... \
//   LIVE_NXT_SALES_SERVICE_USER_ID=... \
//   LIVE_NXT_SALES_SERVICE_USER_EMAIL=... \
//   npx tsx scripts/verify-live-crm.ts

const BASE = process.env.LIVE_NXT_SALES_BASE_URL ?? 'https://nxtsales.altiusnxt.tech'
const SECRET = process.env.LIVE_NXT_SALES_JWT_SECRET ?? ''
const USER_ID = process.env.LIVE_NXT_SALES_SERVICE_USER_ID ?? ''
const USER_EMAIL = process.env.LIVE_NXT_SALES_SERVICE_USER_EMAIL ?? 'marketing-agent@service.local'

let failures = 0
const ok = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`)
}

// ── Refuse to run alongside an enabled write path ─────────────────────────
if (String(process.env.CRM_WRITE_ENABLED).toLowerCase() === 'true') {
  console.error('\nRefusing to run: CRM_WRITE_ENABLED is true.')
  console.error('Live verification is read-only and must not run while writes are enabled.\n')
  process.exit(1)
}

console.log('LIVE NXT SALES — READ-ONLY VERIFICATION')
console.log(`  host                ${BASE}`)
console.log(`  writes enabled      ${process.env.CRM_WRITE_ENABLED ?? 'false'}`)
console.log('')

// ── 1. Unauthenticated health ────────────────────────────────────────────
console.log('1. HEALTH (no credential required)')
try {
  const r = await fetch(`${BASE}/health`, { method: 'GET', signal: AbortSignal.timeout(15000) })
  const body = (await r.json().catch(() => null)) as { status?: string; database?: { ok?: boolean } } | null
  ok('reachable', r.ok, `HTTP ${r.status}`)
  if (body?.database) ok('database healthy', body.database.ok === true)
  else console.log(`  ....  status ${body?.status ?? 'unstated'} (this deployment predates the database probe)`)
} catch (err) {
  ok('reachable', false, (err as Error).message)
}

// ── 2. Credential present? ───────────────────────────────────────────────
console.log('\n2. SERVICE CREDENTIAL')
if (!SECRET || !USER_ID) {
  const missing = [
    SECRET ? null : 'LIVE_NXT_SALES_JWT_SECRET',
    USER_ID ? null : 'LIVE_NXT_SALES_SERVICE_USER_ID',
  ].filter(Boolean)
  console.log(`  ....  not supplied: ${missing.join(', ')}`)
  console.log('')
  console.log('  The live CRM verifies a bearer token by SIGNATURE ONLY:')
  console.log('    jwt.verify(token, process.env.JWT_SECRET)   [server/src/middleware/authMiddleware.js]')
  console.log('  There is no session store and no per-request database lookup, so the live')
  console.log('  JWT_SECRET is the entire credential. Supply it as LIVE_NXT_SALES_JWT_SECRET')
  console.log('  in the shell for this run — do not commit it.')
  console.log('')
  console.log('  Steps 3-5 cannot run without it. Nothing was written.')
  process.exit(failures === 0 ? 0 : 1)
}
console.log('  ....  credential supplied (value not shown)')

/** Mints the same token shape NXT Sales issues at login. Never logged. */
const token = jwt.sign(
  { id: USER_ID, email: USER_EMAIL, name: 'Marketing Agent (service)', role: 'member' },
  SECRET,
  { expiresIn: 300 },
)

/** GET only. There is deliberately no other verb in this file. */
const get = async (path: string) => {
  const r = await fetch(`${BASE}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  let body: unknown = null
  try { body = await r.json() } catch { body = null }
  return { status: r.status, body }
}

// ── 3. Authenticated identity ────────────────────────────────────────────
console.log('\n3. AUTHENTICATED IDENTITY')
const me = await get('/api/auth/me')
ok('token accepted', me.status === 200, `HTTP ${me.status}`)
if (me.status === 200) {
  const u = me.body as { email?: string; role?: string } | null
  console.log(`  ....  identified as ${u?.email ?? '(no email in response)'} role=${u?.role ?? '?'}`)
} else {
  console.log('  ....  the supplied secret does not match the live JWT_SECRET.')
  console.log('        Steps 4-5 skipped. Nothing was written.')
  process.exit(1)
}

// ── 4. Read one Company ──────────────────────────────────────────────────
console.log('\n4. READ ONE COMPANY')
const list = await get('/api/companies?limit=1')
ok('companies readable', list.status === 200, `HTTP ${list.status}`)
const rows = ((list.body as { companies?: unknown[] })?.companies ?? []) as Array<{ id?: string; name?: string }>
ok('at least one company returned', rows.length > 0, `${rows.length} row(s)`)
if (rows[0]?.id) {
  const one = await get(`/api/companies/${rows[0].id}`)
  ok('single company readable', one.status === 200, `${rows[0].name ?? rows[0].id}`)
}

// ── 5. Confirm the two Company custom fields ─────────────────────────────
console.log('\n5. COMPANY CUSTOM FIELDS')
const cf = await get('/api/custom-fields/Company')
ok('custom field definitions readable', cf.status === 200, `HTTP ${cf.status}`)
const defs = (Array.isArray(cf.body) ? cf.body : ((cf.body as { fields?: unknown[] })?.fields ?? [])) as Array<{
  key?: string
  label?: string
  type?: string
  enabled?: boolean
}>
for (const want of ['intentScore', 'qualificationStatus']) {
  const f = defs.find((d) => d.key === want)
  ok(`"${want}" present`, Boolean(f), f ? `${f.label} · ${f.type} · enabled=${f.enabled}` : 'not found')
}
const status = defs.find((d) => d.key === 'qualificationStatus')
if (status) ok('qualificationStatus is a dropdown', status.type === 'dropdown', String(status.type))

// ── 6. The dropdown's options must match the configured mapping ──────────
//
// This is the check that catches the failure the write path cannot survive:
// NXT Sales rejects an unlisted dropdown value with a 400, and a label that
// differs by one character — a capital letter, an en dash — is unlisted.
console.log('\n6. QUALIFICATION STATUS OPTIONS')
const EXPECTED = ['Not Qualified', 'Qualified', 'Qualified - Unassigned', 'De-qualified']
const opts = await get('/api/dropdowns/company.custom.qualificationStatus')
ok('dropdown options readable', opts.status === 200, `HTTP ${opts.status}`)

const raw = (Array.isArray(opts.body) ? opts.body : ((opts.body as { options?: unknown[] })?.options ?? [])) as Array<{
  value?: string
  enabled?: boolean
}>
const live = raw.filter((o) => o.enabled !== false).map((o) => String(o.value))
console.log(`  ....  ${live.length} enabled option(s) on the live field`)

for (const want of EXPECTED) {
  const found = live.includes(want)
  ok(`"${want}" present`, found)
  if (!found) {
    // Name the near-miss rather than leaving someone to spot it by eye.
    const near = live.find((v) => v.replace(/[‐-―−]/g, '-').toLowerCase() === want.toLowerCase())
    if (near) {
      const points = [...near].map((c) => c.codePointAt(0)!.toString(16)).join(' ')
      console.log(`  ....  closest live value is ${JSON.stringify(near)} — codepoints ${points}`)
      console.log('        A dropdown match is exact; this would be rejected with a 400.')
    }
  }
}

const extra = live.filter((v) => !EXPECTED.includes(v))
if (extra.length) console.log(`  ....  other options present (harmless): ${extra.map((v) => JSON.stringify(v)).join(', ')}`)

// Every label the platform would ever send must be reachable.
const { parseStatusMap } = await import('../src/crmsync/writeGate.js')
const mapped = [...parseStatusMap(process.env.CRM_WRITE_QUALIFICATION_VALUE_MAP ?? '').values()]
const unreachable = mapped.filter((v) => !live.includes(v))
ok('every configured mapping targets a live option', unreachable.length === 0,
  unreachable.length ? `unreachable: ${unreachable.join(', ')}` : `${mapped.length} mapping(s) checked`)

console.log(`\n${failures === 0 ? 'LIVE READ-ONLY VERIFICATION PASSED' : `${failures} CHECK(S) FAILED`}`)
console.log('Requests issued: GET only. Zero writes. Nothing in NXT Sales was modified.')
process.exit(failures === 0 ? 0 : 1)
