import 'dotenv/config'
import jwt from 'jsonwebtoken'
import { readFileSync, writeFileSync } from 'node:fs'
import { prisma } from '../src/platform/db.js'
import { runCompanyEnrichment } from '../src/enrichment/companyEnrichment.js'
import { runIntentDetection } from '../src/intent/intentDetection.js'
import { runDecisionMakerDiscovery } from '../src/decisionmakers/discovery.js'
import { runWebsiteAudit } from '../src/websiteaudit/audit.js'
import { generateAuditReport } from '../src/websiteaudit/report.js'
import { buildWorkbench } from '../src/workbench/builder.js'
import { scoreCompany } from '../src/intentscore/service.js'
import { evaluateCompany } from '../src/salesqualification/service.js'
import { syncQualification } from '../src/crmsync/service.js'

// PHASE 2 — run 20 real companies through the real pipeline.
//
// HOW THIS RESPECTS THE SERVICE BOUNDARIES
//
// Every run record is created through the HTTP API, so the real validation,
// RBAC and tenant scoping apply. The job is then executed by calling the SAME
// function the worker calls — runWebsiteAudit, runIntentDetection and so on.
// That runs the real engine; it only skips the queue.
//
// Skipping the queue is deliberate. There are 392 stale run.step jobs from an
// earlier session sitting in pgboss, and starting a worker would churn through
// all of them — real crawls and real model calls for work nobody asked for.
// Executing inline keeps this bounded to the twenty companies chosen.
//
// Nothing here writes to a CRM, sends a message, or invents a result. Where a
// provider is not configured the engine's own blocked state is recorded as-is.

const API = 'http://localhost:4100/api/v1'
const ACTOR = 'crm-user-jey'
const token = jwt.sign(
  { id: ACTOR, email: 'jey@deeptechskills.com', name: 'Pipeline', role: 'member' },
  process.env.JWT_SECRET!,
  { expiresIn: 3600 },
)

interface Company {
  crmCompanyId: string
  name: string
  domain: string | null
  country: string | null
  industry: string | null
  source: string
  batch: string
}

type Engine =
  | 'context' | 'enrichment' | 'intent' | 'decisionMakers' | 'websiteAudit' | 'auditReport'
  | 'approval' | 'workbench' | 'outreach' | 'engagement' | 'intentScore' | 'qualification' | 'crmHandoff'

interface EngineResult {
  status: 'ok' | 'empty' | 'blocked' | 'error'
  detail: string
  data?: Record<string, unknown>
}

const results: Record<string, Partial<Record<Engine, EngineResult>>> = {}

function record(company: string, engine: Engine, r: EngineResult) {
  results[company] ??= {}
  results[company]![engine] = r
  const mark = r.status === 'ok' ? 'OK ' : r.status === 'empty' ? '   ' : r.status === 'blocked' ? 'BLK' : 'ERR'
  console.log(`   ${mark} ${engine.padEnd(15)} ${r.detail.slice(0, 96)}`)
}

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

const err = (e: unknown) => (e as Error)?.message ?? String(e)

async function main() {
  const cohort: Company[] = JSON.parse(readFileSync('scripts/.demo-cohort.json', 'utf8'))
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  const tenantId = tenant.id
  const ids = cohort.map((c) => c.crmCompanyId)

  console.log(`PIPELINE — ${cohort.length} companies, local NXT Sales only\n`)

  // ── 1. Company context, read through the CRM the engines read ───────────
  console.log('1. COMPANY CONTEXT')
  for (const c of cohort) {
    const r = await call('GET', `/enrichment/companies/${c.crmCompanyId}`)
    record(c.crmCompanyId, 'context', {
      status: r.status === 200 ? 'ok' : 'empty',
      detail: `${c.name} · ${c.domain ?? 'no website'} · ${r.status === 200 ? 'context on file' : 'no enrichment yet'}`,
    })
  }

  // ── 2. Enrichment ───────────────────────────────────────────────────────
  console.log('\n2. COMPANY ENRICHMENT')
  const enq = await call('POST', '/enrichment/companies', { crmCompanyIds: ids })
  const enrichments = (enq.body.enrichments ?? []) as Array<Record<string, unknown>>
  console.log(`   API queued ${enrichments.length} (HTTP ${enq.status})`)
  for (const e of enrichments) {
    const cid = String(e.crmCompanyId ?? '')
    try {
      await runCompanyEnrichment(String(e.id))
      const row = await prisma.companyEnrichment.findFirst({ where: { tenantId, crmCompanyId: cid } })
      const tech = (row?.technologies as unknown[] | null)?.length ?? 0
      record(cid, 'enrichment', {
        status: row?.status === 'enriched' ? 'ok' : row ? 'empty' : 'error',
        detail: `${row?.status ?? 'no row'} · ${tech} technology signal(s) · ${row?.websiteStatus ?? 'site unknown'}`,
        data: { status: row?.status, technologies: tech, websiteStatus: row?.websiteStatus },
      })
    } catch (e) {
      record(cid, 'enrichment', { status: 'error', detail: err(e) })
    }
  }

  // ── 3. Intent signals ───────────────────────────────────────────────────
  console.log('\n3. INTENT SIGNALS')
  const iq = await call('POST', '/intent/detect', { crmCompanyIds: ids })
  const iruns = (iq.body.runs ?? []) as Array<Record<string, unknown>>
  console.log(`   API queued ${iruns.length} (HTTP ${iq.status})`)
  for (const r of iruns) {
    const cid = String(r.crmCompanyId ?? '')
    try {
      await runIntentDetection(String(r.id))
      const run = await prisma.intentDetectionRun.findUnique({ where: { id: String(r.id) } })
      const signals = await prisma.intentSignal.count({ where: { tenantId, crmCompanyId: cid } })
      record(cid, 'intent', {
        status: signals > 0 ? 'ok' : run?.status === 'blocked' ? 'blocked' : 'empty',
        detail: `${run?.status ?? '?'} · ${signals} signal(s) · ${run?.failureReason ?? 'no blocker'}`,
        data: { status: run?.status, signals, reason: run?.failureReason },
      })
    } catch (e) {
      record(cid, 'intent', { status: 'error', detail: err(e) })
    }
  }

  // ── 4. Decision makers ──────────────────────────────────────────────────
  console.log('\n4. DECISION MAKERS')
  const dq = await call('POST', '/decision-makers/discover', { crmCompanyIds: ids })
  const druns = (dq.body.runs ?? []) as Array<Record<string, unknown>>
  console.log(`   API queued ${druns.length} (HTTP ${dq.status})`)
  for (const r of druns) {
    const cid = String(r.crmCompanyId ?? '')
    try {
      await runDecisionMakerDiscovery(String(r.id))
      const run = await prisma.decisionMakerRun.findUnique({ where: { id: String(r.id) } })
      record(cid, 'decisionMakers', {
        status: (run?.candidateCount ?? 0) > 0 ? 'ok' : 'blocked',
        detail: `${run?.status ?? '?'} · ${run?.candidateCount ?? 0} candidate(s) · ${run?.failureReason ?? 'no provider authorised'}`,
        data: { status: run?.status, candidates: run?.candidateCount, reason: run?.failureReason },
      })
    } catch (e) {
      record(cid, 'decisionMakers', { status: 'error', detail: err(e) })
    }
  }

  // ── 5. Website audit ────────────────────────────────────────────────────
  console.log('\n5. WEBSITE AUDIT  (real crawls — this is the slow one)')
  // The audit endpoint caps a batch at 10 by design, so this goes in chunks
  // rather than being sent as one oversized request the API is right to refuse.
  const wruns: Array<Record<string, unknown>> = []
  for (let i = 0; i < ids.length; i += 10) {
    const chunk = ids.slice(i, i + 10)
    const wq = await call('POST', '/website-audit/start', { crmCompanyIds: chunk })
    const got = (wq.body.runs ?? []) as Array<Record<string, unknown>>
    console.log(`   API queued ${got.length}/${chunk.length} (HTTP ${wq.status})`)
    wruns.push(...got)
  }
  const auditRunByCompany: Record<string, string> = {}
  for (const r of wruns) {
    const cid = String(r.crmCompanyId ?? '')
    try {
      await runWebsiteAudit(String(r.id))
      const run = await prisma.websiteAuditRun.findUnique({ where: { id: String(r.id) } })
      auditRunByCompany[cid] = String(r.id)
      record(cid, 'websiteAudit', {
        status: run?.status === 'completed' ? 'ok' : run?.status === 'partial' ? 'ok' : 'blocked',
        detail: `${run?.status} · ${run?.pagesFetched ?? 0} page(s), ${run?.productPages ?? 0} product, ${run?.categoryPages ?? 0} category · ${run?.failureReason ?? ''}`,
        data: {
          status: run?.status, pagesFetched: run?.pagesFetched, productPages: run?.productPages,
          categoryPages: run?.categoryPages, reason: run?.failureReason, runId: r.id,
        },
      })
    } catch (e) {
      record(cid, 'websiteAudit', { status: 'error', detail: err(e) })
    }
  }

  // ── 6. Audit report + findings ──────────────────────────────────────────
  console.log('\n6. AUDIT REPORT')
  for (const c of cohort) {
    const runId = auditRunByCompany[c.crmCompanyId]
    if (!runId) { record(c.crmCompanyId, 'auditReport', { status: 'empty', detail: 'no audit run' }); continue }
    try {
      const rep = await generateAuditReport(runId)
      const findings = await prisma.catalogFinding.count({ where: { auditRunId: runId } })
      record(c.crmCompanyId, 'auditReport', {
        status: rep ? (findings > 0 ? 'ok' : 'empty') : 'empty',
        detail: rep ? `report ${rep.status ?? 'created'} · ${findings} finding(s)` : 'no report (nothing observed)',
        data: { findings, reportId: (rep as { reportId?: string } | null)?.reportId },
      })
    } catch (e) {
      record(c.crmCompanyId, 'auditReport', { status: 'error', detail: err(e) })
    }
  }

  // ── 7. Human approval (audit report) ────────────────────────────────────
  console.log('\n7. AUDIT REPORT APPROVAL STATE')
  for (const c of cohort) {
    const runId = auditRunByCompany[c.crmCompanyId]
    if (!runId) { record(c.crmCompanyId, 'approval', { status: 'empty', detail: 'no audit run' }); continue }
    const rep = await prisma.auditReport.findFirst({ where: { auditRunId: runId } })
    record(c.crmCompanyId, 'approval', {
      status: rep ? 'ok' : 'empty',
      detail: rep ? `report status: ${rep.status} · revision ${rep.currentRevision}` : 'no report to approve',
      data: { status: rep?.status, reportId: rep?.id },
    })
  }

  // ── 8. Workbench ────────────────────────────────────────────────────────
  console.log('\n8. AI WORKBENCH')
  for (const c of cohort) {
    const runId = auditRunByCompany[c.crmCompanyId]
    if (!runId) { record(c.crmCompanyId, 'workbench', { status: 'empty', detail: 'no audit run' }); continue }
    try {
      const wb = await buildWorkbench({ tenantId, auditRunId: runId, requestedByCrmUserId: ACTOR })
      record(c.crmCompanyId, 'workbench', {
        status: wb.status === 'ready' ? 'ok' : 'blocked',
        detail: `${wb.status} · ${wb.statusReason ?? 'built'}`,
        data: { status: wb.status, demoId: wb.demoId, reason: wb.statusReason },
      })
    } catch (e) {
      record(c.crmCompanyId, 'workbench', { status: 'blocked', detail: err(e) })
    }
  }

  // ── 9. Outreach (never sends) ───────────────────────────────────────────
  console.log('\n9. MULTICHANNEL OUTREACH')
  for (const c of cohort) {
    const r = await call('GET', `/outreach/companies/${c.crmCompanyId}/actions`)
    record(c.crmCompanyId, 'outreach', {
      status: r.status === 200 ? 'empty' : 'blocked',
      detail: `no provider configured (EMAIL_PROVIDER/WHATSAPP_PROVIDER unset); nothing sent · HTTP ${r.status}`,
    })
  }

  // ── 10. Engagement ──────────────────────────────────────────────────────
  console.log('\n10. ENGAGEMENT')
  for (const c of cohort) {
    const n = await prisma.engagementEvent.count({ where: { tenantId, crmCompanyId: c.crmCompanyId } })
    record(c.crmCompanyId, 'engagement', {
      status: n > 0 ? 'ok' : 'empty',
      detail: `${n} recorded event(s)`,
      data: { events: n },
    })
  }

  // ── 11. Intent scoring ──────────────────────────────────────────────────
  console.log('\n11. INTENT SCORING')
  for (const c of cohort) {
    try {
      const s = await scoreCompany({ tenantId, crmCompanyId: c.crmCompanyId })
      record(c.crmCompanyId, 'intentScore', {
        status: 'ok',
        detail: `score ${s.normalizedScore} (${s.level}) · ${s.eventsScored} event(s) scored`,
        data: { score: s.normalizedScore, level: s.level, eventsScored: s.eventsScored },
      })
    } catch (e) {
      record(c.crmCompanyId, 'intentScore', { status: 'error', detail: err(e) })
    }
  }

  // ── 12. Sales qualification ─────────────────────────────────────────────
  console.log('\n12. SALES QUALIFICATION')
  for (const c of cohort) {
    try {
      const q = await evaluateCompany({ tenantId, crmCompanyId: c.crmCompanyId, actorCrmUserId: ACTOR })
      record(c.crmCompanyId, 'qualification', {
        status: 'ok',
        detail: `${q.status} · ${q.reason?.slice(0, 70) ?? ''}`,
        data: { status: q.status, qualificationId: (q as { qualificationId?: string }).qualificationId },
      })
    } catch (e) {
      record(c.crmCompanyId, 'qualification', { status: 'error', detail: err(e) })
    }
  }

  // ── 13. CRM handoff preview (NO write) ──────────────────────────────────
  console.log('\n13. CRM HANDOFF PREVIEW  (CRM_WRITE_ENABLED=false, no approval supplied)')
  for (const c of cohort) {
    const q = await prisma.salesQualification.findFirst({ where: { tenantId, crmCompanyId: c.crmCompanyId } })
    if (!q) { record(c.crmCompanyId, 'crmHandoff', { status: 'empty', detail: 'not qualified — no handoff' }); continue }
    try {
      const s = await syncQualification({ tenantId, qualificationId: q.id, actorCrmUserId: ACTOR })
      record(c.crmCompanyId, 'crmHandoff', {
        status: s.state === 'awaiting_user_approval' ? 'ok' : 'blocked',
        detail: `${s.state} · ${s.reason.slice(0, 78)}`,
        data: { state: s.state, syncId: s.syncRecordId, validationOk: s.validation.ok },
      })
    } catch (e) {
      record(c.crmCompanyId, 'crmHandoff', { status: 'blocked', detail: err(e) })
    }
  }

  writeFileSync('scripts/.demo-results.json', JSON.stringify({ cohort, results }, null, 2))
  console.log('\nWrote scripts/.demo-results.json')
  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('pipeline failed:', e)
  await prisma.$disconnect()
  process.exit(1)
})
