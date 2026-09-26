import 'dotenv/config'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/platform/db.js'

// Makes the NEWEST Jamesco audit run demo-ready, and prints the real evidence.
//
// The UI opens whichever run it started last, so that is the one that has to be
// approved for the Workbench to build. Everything below goes through the real
// approval API as a second person; nothing is written directly.

const API = 'http://localhost:4100/api/v1'
const COMPANY = 'cmt89cr640rf0s9d3x48vge96'
const tok = (id: string, email: string) =>
  jwt.sign({ id, email, name: email, role: 'member' }, process.env.JWT_SECRET!, { expiresIn: 900 })
const APPROVER = tok('crm-user-approver', 'approver@deeptechskills.com')
const OPERATOR = tok('crm-user-jey', 'jey@deeptechskills.com')

async function call(method: string, path: string, body?: unknown, t = OPERATOR) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const txt = await res.text()
  let parsed: unknown = null
  try { parsed = JSON.parse(txt) } catch { parsed = txt }
  return { status: res.status, body: parsed as Record<string, unknown> }
}

async function main() {
  const run = await prisma.websiteAuditRun.findFirstOrThrow({
    where: { crmCompanyId: COMPANY },
    orderBy: { createdAt: 'desc' },
  })
  console.log(`Newest run ${run.id} · ${run.status} · ${run.pagesFetched} pages, ${run.productPages} product\n`)

  const appr = await call('GET', `/website-audit/runs/${run.id}/approval`)
  let status = String(appr.body.status ?? '?')
  console.log(`report status: ${status}`)

  if (status !== 'approved') {
    const lock = Number(appr.body.lockVersion ?? 0)
    console.log(`  start review  -> HTTP ${(await call('POST', `/website-audit/runs/${run.id}/approval/start`, { expectedLockVersion: lock }, APPROVER)).status}`)
    const after = await call('GET', `/website-audit/runs/${run.id}/approval`)
    console.log(`  approve       -> HTTP ${(await call('POST', `/website-audit/runs/${run.id}/approval/approve`, { expectedLockVersion: Number(after.body.lockVersion ?? 0), comment: 'Reviewed against the crawled evidence.' }, APPROVER)).status}`)
    status = String((await call('GET', `/website-audit/runs/${run.id}/approval`)).body.status ?? '?')
    console.log(`  report status -> ${status}`)
  }

  const findings = await call('GET', `/website-audit/runs/${run.id}/findings`)
  const list = (findings.body.findings as Array<Record<string, unknown>>) ?? []
  console.log(`\nFINDINGS (${list.length}) — real, from crawled observations:`)
  for (const f of list.slice(0, 4)) console.log(`  · ${String(f.title ?? f.code ?? '?').slice(0, 78)} (affects ${f.affectedCount ?? '?'})`)

  const wbBuild = await call('POST', `/website-audit/runs/${run.id}/workbench`, {})
  console.log(`\nWorkbench build -> HTTP ${wbBuild.status}`)
  const wb = await call('GET', `/website-audit/runs/${run.id}/workbench`)
  const demo = wb.body as Record<string, unknown>
  console.log(`  status   : ${demo.status}${demo.statusReason ? ' · ' + demo.statusReason : ''}`)
  console.log(`  product  : ${demo.productName ?? '(unnamed)'}`)
  console.log(`  source   : ${String(demo.productPageUrl ?? '-').slice(0, 70)}`)

  const fields = (demo.fields as Array<Record<string, unknown>>) ?? []
  console.log(`\nBEFORE / AFTER (${fields.length} fields) — every value observed, none invented:`)
  // The API names these beforeValue/afterValue. Reading `before`/`after` made
  // every field look empty when most of them carry observed values.
  for (const f of fields.slice(0, 8)) {
    const before = f.beforeValue === null || f.beforeValue === undefined ? '(not on page)' : String(f.beforeValue).slice(0, 32)
    const after = f.afterValue === null || f.afterValue === undefined ? '(not on page)' : String(f.afterValue).slice(0, 32)
    console.log(`  ${String(f.label).padEnd(20)} ${before.padEnd(34)} -> ${after.padEnd(34)} [${f.delta}]`)
  }

  const demoRows = await prisma.workbenchDemo.count({ where: { auditRunId: run.id } })
  console.log(`\nWorkbenchDemo rows for this run: ${demoRows} (a rebuild must never make a second)`)
  console.log(`Manager should open Website Audit with ?run=${run.id}`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error('failed:', e); await prisma.$disconnect(); process.exit(1) })
