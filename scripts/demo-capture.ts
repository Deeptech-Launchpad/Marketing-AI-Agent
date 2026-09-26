import 'dotenv/config'
import jwt from 'jsonwebtoken'
import { writeFileSync } from 'node:fs'
import { prisma } from '../src/platform/db.js'

// Captures the REAL responses the manager-demo pages read, so the render test
// can replay them instead of replaying a fixture somebody imagined.
//
// This is the point: the Website Audit crash existed precisely because the
// frontend's idea of a response and the response itself had drifted apart. A
// fixture written from the frontend's own types could never have caught it.

const API = 'http://localhost:4100/api/v1'
const COMPANY = 'cmt89cr640rf0s9d3x48vge96'
const token = jwt.sign(
  { id: 'crm-user-jey', email: 'jey@deeptechskills.com', name: 'Capture', role: 'member' },
  process.env.JWT_SECRET!,
  { expiresIn: 900 },
)

async function get(path: string) {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } })
  const text = await res.text()
  let body: unknown = null
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body }
}

async function main() {
  const run = await prisma.websiteAuditRun.findFirstOrThrow({
    where: { crmCompanyId: COMPANY },
    orderBy: { createdAt: 'desc' },
  })

  const paths: Array<[string, string]> = [
    ['auditRun', `/website-audit/runs/${run.id}`],
    ['auditPages', `/website-audit/runs/${run.id}/pages`],
    ['auditFindings', `/website-audit/runs/${run.id}/findings`],
    ['auditApproval', `/website-audit/runs/${run.id}/approval`],
    ['workbench', `/website-audit/runs/${run.id}/workbench`],
    ['enrichment', `/enrichment/companies/${COMPANY}`],
    ['intentSignals', `/intent/companies/${COMPANY}/signals`],
    ['decisionMakers', `/decision-makers/companies/${COMPANY}/candidates`],
    ['intentScore', `/intent-score/companies/${COMPANY}`],
    ['qualification', `/sales-qualification/companies/${COMPANY}`],
    ['crmPending', `/crm-sync/approvals/pending`],
    ['outreachChannels', `/outreach/channels`],
    // The history/timeline endpoints share a URL prefix with their detail
    // endpoints, so they are captured separately and routed exactly.
    ['qualificationHistory', `/sales-qualification/companies/${COMPANY}/history`],
    ['scoreHistory', `/intent-score/companies/${COMPANY}/history?limit=20`],
    ['scoreBreakdown', `/intent-score/companies/${COMPANY}/breakdown`],
    ['engagementTimeline', `/engagement/companies/${COMPANY}/timeline`],
    ['engagementSummary', `/engagement/companies/${COMPANY}/summary`],
  ]

  const captured: Record<string, { status: number; body: unknown }> = {}
  for (const [key, path] of paths) {
    captured[key] = await get(path)
    console.log(`  ${String(captured[key]!.status).padEnd(4)} ${key.padEnd(18)} ${path}`)
  }

  writeFileSync('web/src/test/real-responses.json', JSON.stringify({ runId: run.id, crmCompanyId: COMPANY, captured }, null, 2))
  console.log(`\n  wrote web/src/test/real-responses.json (run ${run.id})`)
  await prisma.$disconnect()
}

main().catch(async (e) => { console.error('capture failed:', e); await prisma.$disconnect(); process.exit(1) })
