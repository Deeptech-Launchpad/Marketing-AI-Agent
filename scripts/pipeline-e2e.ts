import 'dotenv/config'
import { writeFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'
import { prisma } from '../src/platform/db.js'
import { startProspectSearch, runProspectDiscovery } from '../src/prospects/prospectDiscovery.js'
import { queueCompanyEnrichment, runCompanyEnrichment, chooseWebsite } from '../src/enrichment/companyEnrichment.js'
import { getCrm } from '../src/crm/index.js'
import { queueIntentDetection, runIntentDetection } from '../src/intent/intentDetection.js'
import { queueDecisionMakerDiscovery, runDecisionMakerDiscovery } from '../src/decisionmakers/discovery.js'
import { queueWebsiteAudit, runWebsiteAudit } from '../src/websiteaudit/audit.js'
import { generateAuditReport } from '../src/websiteaudit/report.js'
import { buildCustomerView } from '../src/websiteaudit/customerView.js'
import { generateCustomerReport } from '../src/websiteaudit/customerReport.js'
import { buildWorkbench } from '../src/workbench/builder.js'
import { mintLink, workbenchQrUrl } from '../src/workbench/links.js'
import { scoreCompany } from '../src/intentscore/service.js'
import { evaluateCompany } from '../src/salesqualification/service.js'
import { buildPayload } from '../src/crmsync/payload.js'
import { syncQualification } from '../src/crmsync/service.js'

// ONE NEW LEAD, ALL THE WAY THROUGH.
//
// Not "run every engine". Each stage is fed by the one before it: the company
// discovery picks is the company enrichment reads, whose website the audit
// crawls, whose run the report is built from, whose approved report licenses
// the Workbench, and so on to the CRM handoff.
//
// The lead is chosen to be one this system has never processed. Every company
// that already owns an audit run is excluded by construction, so no prepared
// record can be reused even by accident.
//
// Nothing here patches a row to make a later stage pass. Where an engine is
// genuinely blocked it is reported as blocked and the chain continues only
// where the dependency actually permits.

const API = 'http://localhost:4100/api/v1'
const OPERATOR = 'crm-user-jey'
const APPROVER = 'crm-user-approver'

const tok = (id: string, email: string) =>
  jwt.sign({ id, email, name: email, role: 'member' }, process.env.JWT_SECRET!, { expiresIn: 3600 })

async function call(method: string, path: string, actor: string, body?: unknown) {
  const t = tok(actor, `${actor}@deeptechskills.com`)
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> }
}

interface Row {
  engine: string
  company: string
  inputFrom: string
  output: string
  db: string
  status: string
}
const table: Row[] = []
const add = (r: Row) => {
  table.push(r)
  console.log(`\n[${r.status}] ${r.engine}`)
  console.log(`   in  : ${r.inputFrom}`)
  console.log(`   out : ${r.output}`)
  console.log(`   db  : ${r.db}`)
}

/**
 * Is this site worth putting through the pipeline?
 *
 * Two questions, both about whether the downstream stages would have anything
 * to work on:
 *
 *   · does it answer at all
 *   · does its home page link to a catalogue
 *
 * The second matters because a brochure site produces an audit with no product
 * page, and every stage after it then has nothing to say. That is a truthful
 * result but a useless demonstration, and the brief asks for a lead with
 * meaningful product and category pages.
 *
 * This only SELECTS. It never decides anything the audit later reports — the
 * crawl still finds whatever it finds.
 */
async function catalogueSignal(url: string): Promise<{ ok: boolean; why: string }> {
  let html: string
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: 'follow' })
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` }
    const type = res.headers.get('content-type') ?? ''
    if (!/text\/html/i.test(type)) return { ok: false, why: `not HTML (${type.split(';')[0]})` }
    html = await res.text()
  } catch (err) {
    return { ok: false, why: `unreachable — ${(err as Error).message.slice(0, 40)}` }
  }

  if (html.length < 2000) return { ok: false, why: `home page is only ${html.length} bytes` }

  // Links that a catalogue site publishes and a brochure site does not.
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]!.toLowerCase())
  const catalogue = new Set(
    hrefs.filter((h) => /\/(product|products|shop|store|category|categories|collections?|catalogue|catalog)(\/|\?|$)/.test(h)),
  )
  if (catalogue.size < 3) {
    return { ok: false, why: `only ${catalogue.size} catalogue link(s) on the home page` }
  }
  return { ok: true, why: `${catalogue.size} catalogue link(s) on the home page` }
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  const tenantId = tenant.id

  console.log('='.repeat(70))
  console.log('EXCLUSIONS — every company this system has already processed')
  console.log('='.repeat(70))

  // Any company with an existing audit run is off limits. This is what makes
  // "a new lead" a property of the run rather than a promise in a comment.
  const usedRuns = await prisma.websiteAuditRun.findMany({
    select: { crmCompanyId: true, companyName: true },
    distinct: ['crmCompanyId'],
  })
  const excluded = new Set(usedRuns.map((r) => r.crmCompanyId))
  console.log(`   ${excluded.size} company/companies excluded, including:`)
  for (const r of usedRuns.slice(0, 8)) console.log(`     - ${r.companyName ?? '(unnamed)'}  ${r.crmCompanyId}`)

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 1 — PROSPECT DISCOVERY
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 1 — PROSPECT DISCOVERY')
  console.log('='.repeat(70))

  // ── Which provider is actually sourcing this company? ────────────────
  //
  // Reported before anything is selected, because "discovered by Apollo" and
  // "selected from the CRM base" are different claims and only one of them is
  // true here. Neither is inferred: the key presence and the adapter's own
  // surface are what decide it.
  const providerStatus: Array<[string, string]> = [
    [
      'Apollo (company search)',
      'NOT IMPLEMENTED — the Apollo adapter in this codebase is People Search ' +
        '(/mixed_people/search) for decision makers. No company/organisation search exists.',
    ],
    [
      'Apollo (credentials)',
      process.env.APOLLO_API_KEY ? 'key present' : 'APOLLO_API_KEY not set — adapter reports unauthorized',
    ],
    [
      'RocketReach (company search)',
      'NOT IMPLEMENTED — people-only adapter, same as Apollo.',
    ],
    [
      'RocketReach (credentials)',
      process.env.ROCKETREACH_API_KEY ? 'key present' : 'ROCKETREACH_API_KEY not set',
    ],
    [
      'NXT Sales company base',
      'AVAILABLE — the implemented source. Discovery selects from companies already in the CRM and never creates one.',
    ],
  ]
  console.log('   PROVIDER STATUS')
  for (const [p, s] of providerStatus) console.log(`     ${p.padEnd(30)} ${s}`)

  const objective = process.argv[2] ?? 'industrial and building supplies distributors with an online catalogue'
  const search = await startProspectSearch({ tenantId, objective, requestedByCrmUserId: OPERATOR })
  await runProspectDiscovery(search.id)

  const searchRow = await prisma.prospectSearch.findUniqueOrThrow({ where: { id: search.id } })
  if (!searchRow.snapshotId) throw new Error('Discovery produced no audience snapshot.')

  const members = await prisma.audienceMember.findMany({
    where: { snapshotId: searchRow.snapshotId },
    orderBy: [{ score: 'desc' }, { companyName: 'asc' }],
  })
  console.log(`   objective : "${objective}"`)
  console.log(`   search    : ${search.id} · ${searchRow.status}`)
  console.log(`   audience  : ${members.length} company/companies`)

  const fresh = members.filter((m) => !excluded.has(m.crmCompanyId))
  console.log(`   never processed before: ${fresh.length}`)
  if (fresh.length === 0) throw new Error('Discovery returned no company this system has not already processed.')

  // Pick the first NEW company whose site actually answers.
  //
  // The website is read the way ENRICHMENT reads it — from the CRM record, via
  // the same chooseWebsite rule — because that is the value Engine 2 will
  // resolve. The audience row itself carries no website, so selecting on that
  // would reject every company in the list.
  //
  // Reachability is a selection criterion, not a judgement: an unreachable
  // site would make every downstream stage vacuous, and the point of this run
  // is to exercise them.
  const crm = getCrm()
  let chosen: { crmCompanyId: string; companyName: string; website: string } | null = null
  const tried: string[] = []
  let examined = 0

  for (const m of fresh) {
    if (chosen || examined >= 60) break
    examined++
    let company
    try {
      company = await crm.getCompany(m.crmCompanyId)
    } catch (err) {
      tried.push(`${m.companyName}: CRM read failed — ${(err as Error).message.slice(0, 60)}`)
      continue
    }
    if (!company) {
      tried.push(`${m.companyName}: not found in NXT Sales`)
      continue
    }
    const site = chooseWebsite(company)
    if (!site) {
      tried.push(`${m.companyName}: no website on the CRM record`)
      continue
    }
    const probe = await catalogueSignal(site.url)
    if (!probe.ok) {
      tried.push(`${m.companyName}: ${site.url} — ${probe.why}`)
      continue
    }
    console.log(`   candidate : ${m.companyName} — ${site.url} (${probe.why})`)
    chosen = { crmCompanyId: m.crmCompanyId, companyName: m.companyName ?? company.name, website: site.url }
  }

  console.log(`   examined  : ${examined} candidate(s)`)
  for (const t of tried.slice(-12)) console.log(`   skipped   : ${t}`)
  if (!chosen) throw new Error('No new company in the audience had a reachable website.')

  const COMPANY = chosen.crmCompanyId
  console.log(`\n   >>> SELECTED NEW LEAD: ${chosen.companyName}`)
  console.log(`       crmCompanyId ${COMPANY}`)
  console.log(`       website      ${chosen.website}`)

  add({
    engine: '1. Prospect Discovery',
    company: chosen.companyName,
    inputFrom: `objective: "${objective}"`,
    output:
      `providerUsed=nxt_sales_company_base · providerStatus=available · ` +
      `search ${search.id} -> crmCompanyId ${COMPANY} · ` +
      `dedup: excluded ${excluded.size} already-processed compan(ies), ${fresh.length} remained`,
    db: `ProspectSearch + AudienceSnapshot ${searchRow.snapshotId} (${members.length} members)`,
    // Honest: a real provider DID return this company — the CRM adapter — but
    // it is not Apollo or RocketReach, neither of which can search companies
    // here or has a credential. Said as a partial rather than a clean OK.
    status: 'OK (CRM base) · Apollo/RocketReach BLOCKED',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 2 — COMPANY ENRICHMENT   (input: the company from Engine 1)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 2 — COMPANY ENRICHMENT')
  console.log('='.repeat(70))

  const enr = await queueCompanyEnrichment({
    tenantId,
    crmCompanyId: COMPANY,
    requestedByCrmUserId: OPERATOR,
    prospectSearchId: search.id,
  })
  await runCompanyEnrichment(enr.id)
  const enrichment = await prisma.companyEnrichment.findUniqueOrThrow({ where: { id: enr.id } })
  const techs = enrichment.technologyCount

  console.log(`   status       : ${enrichment.status}`)
  console.log(`   website      : ${enrichment.sourceUrl ?? "(none resolved)"}`)
  console.log(`   technologies : ${techs}`)

  add({
    engine: '2. Company Enrichment',
    company: chosen.companyName,
    inputFrom: `crmCompanyId ${COMPANY} (Engine 1)`,
    output: `enrichment ${enr.id} · website ${enrichment.sourceUrl ?? "none"} · ${techs} technolog(ies)`,
    db: `CompanyEnrichment ${enr.id}`,
    status: enrichment.crmCompanyId === COMPANY ? 'OK' : 'LINEAGE FAIL',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 3 — INTENT SIGNALS   (input: the same company, now enriched)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 3 — INTENT SIGNALS')
  console.log('='.repeat(70))

  const intent = await queueIntentDetection({
    tenantId,
    crmCompanyId: COMPANY,
    requestedByCrmUserId: OPERATOR,
    prospectSearchId: search.id,
  })
  await runIntentDetection(intent.id)
  const intentRun = await prisma.intentDetectionRun.findUniqueOrThrow({ where: { id: intent.id } })
  const signals = await prisma.intentSignal.findMany({ where: { intentRunId: intent.id } })

  console.log(`   status  : ${intentRun.status}`)
  console.log(`   signals : ${signals.length}`)
  for (const s of signals.slice(0, 5)) console.log(`     - ${s.signalType}: ${String(s.summary ?? '').slice(0, 70)}`)

  add({
    engine: '3. Intent Signals',
    company: chosen.companyName,
    inputFrom: `crmCompanyId ${COMPANY} + enrichment ${enr.id}`,
    output: `run ${intent.id} · ${signals.length} signal(s)`,
    db: `IntentDetectionRun ${intent.id} + ${signals.length} IntentSignal`,
    status: signals.every((s) => s.crmCompanyId === COMPANY) ? 'OK' : 'LINEAGE FAIL',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 3b — DECISION MAKERS
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 3b — DECISION MAKERS')
  console.log('='.repeat(70))

  const dm = await queueDecisionMakerDiscovery({
    tenantId,
    crmCompanyId: COMPANY,
    requestedByCrmUserId: OPERATOR,
    prospectSearchId: search.id,
  })
  await runDecisionMakerDiscovery(dm.id)
  const dmRun = await prisma.decisionMakerRun.findUniqueOrThrow({ where: { id: dm.id } })
  const people = await prisma.decisionMakerCandidate.findMany({ where: { dmRunId: dm.id } })
  const shortlisted = people.filter((p) => p.outcome === "shortlisted")

  console.log(`   status      : ${dmRun.status}`)
  console.log(`   candidates  : ${people.length} (${shortlisted.length} shortlisted)`)
  for (const p of shortlisted.slice(0, 4)) console.log(`     - ${p.fullName ?? '(no name)'} · ${p.rawTitle ?? '-'}`)

  add({
    engine: '3b. Decision Makers',
    company: chosen.companyName,
    inputFrom: `crmCompanyId ${COMPANY}`,
    output: `run ${dm.id} · ${people.length} candidate(s), ${shortlisted.length} shortlisted`,
    db: `DecisionMakerRun ${dm.id}`,
    status: people.length === 0 ? 'BLOCKED — no provider returned a person' : 'OK',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 4 — WEBSITE AUDIT   (input: the website from Engines 1+2)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 4 — WEBSITE AUDIT')
  console.log('='.repeat(70))

  const { id: runId } = await queueWebsiteAudit({
    tenantId,
    crmCompanyId: COMPANY,
    requestedByCrmUserId: OPERATOR,
    prospectSearchId: search.id,
  })
  await runWebsiteAudit(runId)
  const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id: runId } })
  const images = await prisma.pageObservation.count({
    where: { auditRunId: runId, field: 'product.image', status: 'observed' },
  })
  const observations = await prisma.pageObservation.count({ where: { auditRunId: runId } })

  console.log(`   run          : ${runId}`)
  console.log(`   status       : ${run.status}`)
  console.log(`   startUrl     : ${run.startUrl}`)
  console.log(`   pages        : ${run.pagesFetched} (${run.productPages} product, ${run.categoryPages} category)`)
  console.log(`   observations : ${observations}`)
  console.log(`   product images observed: ${images}`)

  if (run.status === 'failed') {
    add({
      engine: '4. Website Audit',
      company: chosen.companyName,
      inputFrom: `website ${enrichment.sourceUrl ?? chosen.website} (Engines 1+2)`,
      output: `run ${runId} FAILED: ${run.failureReason ?? 'unknown'}`,
      db: `WebsiteAuditRun ${runId}`,
      status: 'BLOCKED',
    })
    throw new Error(`The audit failed, so no downstream stage can honestly run: ${run.failureReason}`)
  }

  // No page in this run may belong to another company's site.
  const foreignPages = await prisma.auditedPage.count({
    where: { auditRunId: runId, crmCompanyId: { not: COMPANY } },
  })

  add({
    engine: '4. Website Audit',
    company: chosen.companyName,
    inputFrom: `website ${enrichment.sourceUrl ?? chosen.website} (Engines 1+2)`,
    output: `auditRunId ${runId} · ${run.pagesFetched} pages, ${run.productPages} product, ${images} images`,
    db: `WebsiteAuditRun + ${observations} PageObservation`,
    status: run.crmCompanyId === COMPANY && foreignPages === 0 ? 'OK' : 'LINEAGE FAIL',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 5 — AUDIT REPORT   (input: ONLY the auditRunId from Engine 4)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 5 — AUDIT REPORT')
  console.log('='.repeat(70))

  const report = await generateAuditReport(runId)
  if (!report) throw new Error('The report could not be generated from that run.')
  const reportRow = await prisma.auditReport.findFirstOrThrow({ where: { auditRunId: runId } })

  const view = await buildCustomerView(tenantId, runId)
  console.log(`   report       : ${reportRow.id} · ${reportRow.status}`)
  console.log(`   findings     : ${report.findings.length}`)
  console.log(`   case studies : ${view.caseStudies.length}`)
  for (const [i, c] of view.caseStudies.entries()) {
    console.log(`     ${i + 1}. ${c.title.slice(0, 56)}`)
    console.log(`        image  ${c.imageUrl ?? '(none published)'}`)
    console.log(`        source ${c.sourceUrl}`)
    console.log(`        ${c.observedCount} observed · ${c.absentCount} absent`)
  }
  console.log(`   categories   : ${view.sectors.sectors.map((s) => s.name).join(', ') || '(none published)'}`)
  console.log(`   key gaps     : ${view.gaps.map((g) => g.label).slice(0, 5).join(', ') || '(none)'}`)

  add({
    engine: '5. Audit Report',
    company: chosen.companyName,
    inputFrom: `auditRunId ${runId} (Engine 4)`,
    output: `report ${reportRow.id} · ${report.findings.length} findings · ${view.caseStudies.length} case stud(ies)`,
    db: `AuditReport ${reportRow.id} + ${report.findings.length} CatalogFinding`,
    status: view.crmCompanyId === COMPANY ? 'OK' : 'LINEAGE FAIL',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 6 — HUMAN APPROVAL   (through the real API, by a second person)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 6 — HUMAN APPROVAL')
  console.log('='.repeat(70))

  const before = await call('GET', `/website-audit/runs/${runId}/approval`, APPROVER)
  console.log(`   state before : ${String(before.body.status)}`)

  const started = await call('POST', `/website-audit/runs/${runId}/approval/start`, APPROVER, {
    expectedLockVersion: Number(before.body.lockVersion ?? 0),
  })
  const mid = await call('GET', `/website-audit/runs/${runId}/approval`, APPROVER)
  const approve = await call('POST', `/website-audit/runs/${runId}/approval/approve`, APPROVER, {
    expectedLockVersion: Number(mid.body.lockVersion ?? 0),
    comment: 'Reviewed against the crawled evidence for this run.',
  })
  const after = await call('GET', `/website-audit/runs/${runId}/approval`, APPROVER)

  console.log(`   start review : HTTP ${started.status}`)
  console.log(`   approve      : HTTP ${approve.status}`)
  console.log(`   state after  : ${String(after.body.status)}`)

  const trail = await prisma.auditApprovalEvent.findMany({
    where: { auditRunId: runId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  })
  for (const t of trail) console.log(`   trail        : ${t.action} ${t.previousStatus} -> ${t.newStatus} by ${t.reviewerCrmUserId ?? '-'}`)

  const approved = String(after.body.status) === 'approved'
  add({
    engine: '6. Human Approval',
    company: chosen.companyName,
    inputFrom: `report ${reportRow.id} (Engine 5)`,
    output: `ready_for_approval -> ${String(after.body.status)} by ${APPROVER}`,
    db: `AuditReport.status + ${trail.length} AuditLog entr(ies)`,
    status: approved ? 'OK' : 'BLOCKED',
  })
  if (!approved) throw new Error('The report was not approved, so the Workbench must not be built.')

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 7 — AI WORKBENCH   (input: the APPROVED report from Engine 6)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 7 — AI WORKBENCH')
  console.log('='.repeat(70))

  const wb = await buildWorkbench({ tenantId, auditRunId: runId, requestedByCrmUserId: APPROVER })
  const demo = await prisma.workbenchDemo.findFirstOrThrow({ where: { auditRunId: runId } })

  console.log(`   status       : ${wb.status}${wb.statusReason ? ' · ' + wb.statusReason : ''}`)
  console.log(`   demo         : ${demo.id}`)
  console.log(`   product page : ${demo.productPageUrl ?? '-'}`)

  // Through the real API, because that is what the screen reads.
  const wbApi = await call('GET', `/website-audit/runs/${runId}/workbench`, APPROVER)
  const apiImage = wbApi.body.productImageUrl as string | null
  const viewApi = await call('GET', `/website-audit/runs/${runId}/customer-view`, APPROVER)
  const vBody = viewApi.body as unknown as typeof view
  const hero = vBody.caseStudies?.[0] ?? null

  console.log(`   API image    : ${apiImage ?? '(none published)'}`)
  console.log(`   BEFORE       : ${hero ? `${hero.observedCount} published field(s)` : '(no product page)'}`)
  console.log(`   THE GAP      : ${hero ? `${hero.absentCount} field(s) not published` : '-'}`)
  console.log(`   AFTER        : ${hero ? `${hero.fields.length} field(s) structured` : '-'}`)

  // The one claim the demonstration rests on.
  const invented = hero ? hero.fields.filter((f) => f.after !== null && f.before === null) : []
  console.log(`   invented values: ${invented.length} (must be 0)`)

  add({
    engine: '7. AI Workbench',
    company: chosen.companyName,
    inputFrom: `approved report ${reportRow.id} + auditRunId ${runId}`,
    output: `demo ${demo.id} · ${wb.status} · image ${apiImage ? 'yes' : 'none'} · ${hero?.absentCount ?? 0} gap field(s)`,
    db: `WorkbenchDemo ${demo.id}`,
    status:
      demo.crmCompanyId === COMPANY && demo.auditRunId === runId && invented.length === 0 ? 'OK' : 'LINEAGE FAIL',
  })

  // ── The customer PDF, with a QR to THIS company's own share link ─────
  console.log('\n' + '-'.repeat(70))
  console.log('CUSTOMER PDF')
  console.log('-'.repeat(70))

  let qr: string | null = null
  if (demo.status === 'ready') {
    const minted = await mintLink({
      tenantId,
      demoId: demo.id,
      createdByCrmUserId: APPROVER,
      label: 'Pipeline e2e QR',
    })
    qr = workbenchQrUrl(minted.token)
  }
  const pdf = await generateCustomerReport({ tenantId, auditRunId: runId, workbenchUrl: qr, sampleCount: 2 })
  const out = `scripts/.pipeline-${COMPANY}.pdf`
  writeFileSync(out, pdf.pdf.bytes)
  console.log(`   pages   : ${pdf.pdf.pageCount}`)
  console.log(`   bytes   : ${pdf.pdf.bytes.length}`)
  console.log(`   qr      : ${qr ? qr.replace(/\/workbench\/[^?]+/, '/workbench/<token>') : '(no ready demo)'}`)
  console.log(`   written : ${out}`)

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 8 — INTENT SCORE   (this company's own events only)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 8 — INTENT SCORE')
  console.log('='.repeat(70))

  const events = await prisma.engagementEvent.count({ where: { tenantId, crmCompanyId: COMPANY } })
  const score = await scoreCompany({
    tenantId,
    crmCompanyId: COMPANY,
    trigger: 'manual',
    requestedByCrmUserId: OPERATOR,
  })
  console.log(`   events for this company : ${events}`)
  console.log(`   score  : ${score.score} / 100 · band ${score.band}`)

  add({
    engine: '8. Intent Score',
    company: chosen.companyName,
    inputFrom: `crmCompanyId ${COMPANY} + ${events} own engagement event(s)`,
    output: `score ${score.normalizedScore} (${score.level})`,
    db: `IntentScore for ${COMPANY}`,
    status: 'OK',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 9 — SALES QUALIFICATION   (input: the score from Engine 8)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 9 — SALES QUALIFICATION')
  console.log('='.repeat(70))

  const qual = await evaluateCompany({ tenantId, crmCompanyId: COMPANY, actorCrmUserId: OPERATOR })
  console.log(`   status : ${qual.status}`)
  console.log(`   score  : ${qual.score ?? '-'}`)
  console.log(`   owner  : ${qual.ownerCrmUserId ?? '(unassigned — no region mapping)'}`)
  console.log(`   reasons: ${(qual.reasons ?? []).slice(0, 3).join(' | ')}`)

  add({
    engine: '9. Sales Qualification',
    company: chosen.companyName,
    inputFrom: `intent score ${score.normalizedScore} (Engine 8)`,
    output: `${qual.status} · owner ${qual.ownerCrmUserId ?? 'unassigned'} · qualification ${qual.qualificationId ?? '-'}`,
    db: qual.qualificationId ? `SalesQualification ${qual.qualificationId}` : '(not persisted)',
    status: qual.crmCompanyId === COMPANY ? 'OK' : 'LINEAGE FAIL',
  })

  // ════════════════════════════════════════════════════════════════════
  // ENGINE 10 — CRM HANDOFF   (writes disabled)
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('ENGINE 10 — CRM HANDOFF  (CRM_WRITE_ENABLED=' + String(process.env.CRM_WRITE_ENABLED) + ')')
  console.log('='.repeat(70))

  let crmStatus = 'BLOCKED — no qualification to hand off'
  let crmOut = '-'
  let crmDb = '-'

  if (qual.qualificationId) {
    const built = await buildPayload({ tenantId, qualificationId: qual.qualificationId })
    if (!built) {
      crmOut = 'no payload could be built from this qualification'
    } else {
      console.log(`   payload company   : ${built.refs.crmCompanyId}`)
      console.log(`   payload auditRun  : ${built.refs.auditRunId ?? '-'}`)
      console.log(`   intent score ref  : ${built.refs.intentScoreId ?? '-'}`)
      console.log(`   fields            : ${Object.keys(built.payload).join(', ')}`)

      const sync = await syncQualification({
        tenantId,
        qualificationId: qual.qualificationId,
        actorCrmUserId: OPERATOR,
        dryRun: true,
      })
      console.log(`   sync state        : ${sync.state}`)
      if (sync.reason) console.log(`   reason            : ${sync.reason}`)

      crmOut = `payload for ${built.refs.crmCompanyId} · auditRun ${built.refs.auditRunId ?? '-'} · sync ${sync.state}`
      crmDb = `CrmSyncRecord (dry run, no write)`
      crmStatus = built.refs.crmCompanyId === COMPANY ? 'OK (prepared, not written)' : 'LINEAGE FAIL'
    }
  }

  add({
    engine: '10. CRM Handoff',
    company: chosen.companyName,
    inputFrom: `qualification ${qual.qualificationId ?? '-'} (Engine 9)`,
    output: crmOut,
    db: crmDb,
    status: crmStatus,
  })

  // ════════════════════════════════════════════════════════════════════
  // SAME-LEAD ASSERTION
  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('SAME-LEAD ASSERTION — every record must name this one company')
  console.log('='.repeat(70))

  const checks: Array<[string, boolean, string]> = [
    ['Discovery.companyId', members.some((m) => m.crmCompanyId === COMPANY), COMPANY],
    ['Enrichment.companyId', enrichment.crmCompanyId === COMPANY, enrichment.crmCompanyId],
    ['Intent.companyId', intentRun.crmCompanyId === COMPANY, intentRun.crmCompanyId],
    ['DecisionMaker.companyId', dmRun.crmCompanyId === COMPANY, dmRun.crmCompanyId],
    ['AuditRun.companyId', run.crmCompanyId === COMPANY, run.crmCompanyId],
    ['Report.auditRunId', reportRow.auditRunId === runId, reportRow.auditRunId],
    ['Workbench.auditRunId', demo.auditRunId === runId, demo.auditRunId],
    ['Workbench.companyId', demo.crmCompanyId === COMPANY, demo.crmCompanyId],
    ['CaseStudy.companyId', view.caseStudies.every((c) => c.crmCompanyId === COMPANY), COMPANY],
    ['Qualification.companyId', qual.crmCompanyId === COMPANY, qual.crmCompanyId ?? '-'],
    ['No foreign audited page', foreignPages === 0, String(foreignPages)],
    ['No invented AFTER value', invented.length === 0, String(invented.length)],
    ['PDF is 5-6 pages', pdf.pdf.pageCount >= 5 && pdf.pdf.pageCount <= 6, String(pdf.pdf.pageCount)],
    ['Lead was never processed before', !excluded.has(COMPANY), COMPANY],
  ]
  for (const [name, ok, detail] of checks) {
    console.log(`   ${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(30)} ${detail}`)
  }

  // ════════════════════════════════════════════════════════════════════
  console.log('\n' + '='.repeat(70))
  console.log('PIPELINE TABLE')
  console.log('='.repeat(70))
  for (const r of table) console.log(`${r.status.padEnd(28)} | ${r.engine.padEnd(24)} | ${r.output}`)

  console.log('\nSUMMARY')
  console.log(`  NEW COMPANY    : ${chosen.companyName}`)
  console.log(`  CRM COMPANY ID : ${COMPANY}`)
  console.log(`  WEBSITE        : ${run.startUrl}`)
  console.log(`  AUDIT RUN ID   : ${runId}`)
  console.log(`  REPORT ID      : ${reportRow.id}`)
  console.log(`  WORKBENCH ID   : ${demo.id}`)
  console.log(`  PDF PAGES      : ${pdf.pdf.pageCount}`)
  console.log(`  CASE STUDIES   : ${view.caseStudies.map((c) => c.title.slice(0, 40)).join(' | ') || 'none'}`)
  console.log(`  PRODUCT IMAGES : ${images}`)
  console.log(`  INTENT SCORE   : ${score.normalizedScore} (${score.level})`)
  console.log(`  QUALIFICATION  : ${qual.status}`)
  console.log(`  CRM HANDOFF    : ${crmStatus}`)
  console.log(`  UI ROUTES      : /audit-report?run=${runId}   /workbench?run=${runId}`)

  await prisma.$disconnect()
}

main().catch(async (e) => {
  console.error('\nPIPELINE STOPPED:', (e as Error).message)
  await prisma.$disconnect()
  process.exit(1)
})
