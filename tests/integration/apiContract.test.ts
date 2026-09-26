import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'
import jwt from 'jsonwebtoken'

// THE THREE URLS THE BROWSER ACTUALLY ASKS FOR.
//
// All three of these 404'd in a live demonstration, and the diagnosis "the
// route is missing" was wrong every time: they are mounted, and each answered
// 404 because the thing BEHIND it had not been built yet. Nothing pinned that
// down, so a rename or a changed mount would have produced the same screen and
// the same wrong diagnosis.
//
// This file is that pin. It boots the REAL Express app on an ephemeral port —
// the same createServer() the process uses, through the real authenticate and
// requirePermission middleware — and asks for the exact paths the frontend
// asks for:
//
//   GET /api/v1/website-audit/runs/:id/customer-view
//   GET /api/v1/website-audit/runs/:id/workbench
//   GET /api/v1/decision-makers/companies/:crmCompanyId/candidates
//
// The load-bearing assertion is the one that separates the TWO KINDS OF 404,
// because the frontend has to make that distinction from the response alone:
//
//   · a MOUNTED route with nothing to show answers 404 with our envelope
//     { error: { code, message } } and a message naming what is missing
//   · an UNMOUNTED path falls through to the app's terminal handler and gets
//     the fixed message "No such endpoint."
//
// So the unmounted case is asserted here too, as the control. Without it the
// envelope assertion would pass for a route that had been deleted.

async function ready(): Promise<string | null> {
  if (process.env.CRM_DRIVER !== 'real') return `CRM_DRIVER is "${process.env.CRM_DRIVER}", not "real"`
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    return `marketing database unavailable: ${(err as Error).message}`
  }
  return null
}

const skipReason = await ready()
const describeIfReady = skipReason ? describe.skip : describe
if (skipReason) console.warn(`\n[apiContract] SKIPPED — ${skipReason}\n`)

/** Everything this file creates is swept by this prefix, never by exact id. */
const PREFIX = `apicontract-${Date.now().toString(36)}`
const MINE = `${PREFIX}-mine`
const OTHER = `${PREFIX}-other`
/** A company whose only discovery run never completed — the A1 shape. */
const NEVER_COMPLETED = `${PREFIX}-nodm`

const VIEWER = {
  id: `${PREFIX}-viewer`,
  email: `${PREFIX}-viewer@altiusnxt.test`,
  role: 'viewer',
}

/** What the app's terminal handler says when nothing matched the path. */
const UNMOUNTED_MESSAGE = 'No such endpoint.'

let server: Server
let base = ''
let tenantId = ''

/** MINE: crawled, reported, demonstrated. Every endpoint has something to say. */
let mineRun = ''
let mineReport = ''
let mineProductPage = ''
/** MINE: reported but never demonstrated. Only the Workbench is empty. */
let mineNoWorkbenchRun = ''
/** MINE: queued and never crawled, so there is no report to read. */
let mineNoReportRun = ''
/** OTHER: a second company, fully populated, so leakage is possible to detect. */
let otherRun = ''
let otherDmRun = ''

function tokenFor(u: { id: string; email: string }): string {
  // Signed with the secret the app verifies with, so the real middleware runs.
  return jwt.sign({ id: u.id, email: u.email, name: u.email }, process.env.JWT_SECRET!, { expiresIn: 300 })
}

interface ApiResponse {
  status: number
  contentType: string
  body: Record<string, unknown>
  code: string
  message: string
  raw: string
}

async function get(path: string, token?: string): Promise<ApiResponse> {
  const res = await fetch(`${base}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  // Read as TEXT first: an Express default 404 is HTML, and .json() would throw
  // on it — which is exactly the failure this file has to be able to describe.
  const raw = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    body = {}
  }
  const err = body.error as { code?: string; message?: string } | undefined
  return {
    status: res.status,
    contentType: res.headers.get('content-type') ?? '',
    body,
    code: err?.code ?? '',
    message: err?.message ?? '',
    raw,
  }
}

/**
 * "The route is mounted; it has nothing to show."
 *
 * This is the assertion the whole file exists for. A frontend reading a 404
 * shaped like this may render "not built yet"; a 404 that fails any of these
 * is an API fault and must never be rendered as an empty result.
 */
function expectMountedNotFound(r: ApiResponse, names: RegExp): void {
  expect(r.status).toBe(404)
  expect(r.contentType, 'never Express’s default HTML 404').toMatch(/application\/json/)
  expect(r.code, 'the API error envelope carries a code').toBe('not_found')
  expect(r.message.length, 'and a message').toBeGreaterThan(0)
  expect(r.message, 'a mounted route never answers the terminal handler’s message').not.toBe(UNMOUNTED_MESSAGE)
  expect(r.message, 'the message must say what is missing').toMatch(names)
}

async function seedAudit(opts: {
  crmCompanyId: string
  companyName: string
  website: string
  reportStatus: string
  products: Array<{ slug: string; name: string; sku: string }>
}): Promise<{ runId: string; reportId: string; pageIds: string[] }> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const runId = newId()
  await prisma.websiteAuditRun.create({
    data: {
      id: runId,
      tenantId,
      crmCompanyId: opts.crmCompanyId,
      requestedByCrmUserId: VIEWER.id,
      status: 'completed',
      companyName: opts.companyName,
      startUrl: opts.website,
      pagesFetched: opts.products.length,
      productPages: opts.products.length,
      categoryPages: 0,
      completedAt: new Date(),
    },
  })

  const pageIds: string[] = []
  for (const p of opts.products) {
    const pageId = newId()
    pageIds.push(pageId)
    const url = `${opts.website}/product/${p.slug}/`
    await prisma.auditedPage.create({
      data: {
        id: pageId,
        tenantId,
        auditRunId: runId,
        crmCompanyId: opts.crmCompanyId,
        requestedUrl: url,
        finalUrl: url,
        httpStatus: 200,
        outcome: 'fetched',
        pageType: 'product',
        fetchedAt: new Date(),
      },
    })
    for (const o of [
      { field: 'product.name', value: p.name },
      { field: 'product.sku', value: p.sku },
      { field: 'product.image', value: `${opts.website}/img/${p.slug}.jpg` },
      { field: 'product.brand', value: null },
      { field: 'product.availability', value: null },
    ]) {
      await prisma.pageObservation.create({
        data: {
          id: newId(),
          tenantId,
          auditRunId: runId,
          pageId,
          field: o.field,
          status: o.value ? 'observed' : 'not_observed',
          value: o.value,
          method: 'dom_heuristic',
          sourcePath: 'test',
        },
      })
    }
  }

  const reportId = newId()
  await prisma.auditReport.create({
    data: {
      id: reportId,
      tenantId,
      auditRunId: runId,
      crmCompanyId: opts.crmCompanyId,
      companyName: opts.companyName,
      websiteUrl: opts.website,
      auditDate: new Date(),
      pagesInspected: opts.products.length,
      productPagesInspected: opts.products.length,
      status: opts.reportStatus,
      collateral: {
        headline: `Product Data Health Check — ${opts.companyName}`,
        summary: `A summary written about ${opts.companyName}.`,
        scopeNote: 'Scope: every figure describes the inspected pages only.',
        businessImpact: ['Products become filterable.'],
        nextStep: 'A fifteen-minute walkthrough.',
        cta: { label: 'Book a 15-minute walkthrough', url: null },
      },
    },
  })

  return { runId, reportId, pageIds }
}

async function seedWorkbench(opts: {
  crmCompanyId: string
  companyName: string
  website: string
  runId: string
  reportId: string
  pageId: string
  productName: string
}): Promise<string> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const demoId = newId()
  await prisma.workbenchDemo.create({
    data: {
      id: demoId,
      tenantId,
      auditRunId: opts.runId,
      auditReportId: opts.reportId,
      crmCompanyId: opts.crmCompanyId,
      companyName: opts.companyName,
      websiteUrl: opts.website,
      productPageId: opts.pageId,
      productPageUrl: `${opts.website}/product/pump/`,
      productName: opts.productName,
      selectionReason: 'The only inspected product page.',
      status: 'ready',
      sourceReportStatus: 'approved',
      observedFieldCount: 3,
      totalFieldCount: 5,
      improvedFieldCount: 1,
    },
  })
  await prisma.workbenchField.create({
    data: {
      id: newId(),
      tenantId,
      demoId,
      field: 'product.name',
      label: 'Product name',
      position: 0,
      beforeValue: opts.productName,
      afterValue: `${opts.productName} (structured)`,
      delta: 'restructured',
      headline: true,
      transformKind: 'restructured',
      sourceField: 'product.name',
      sourceUrl: `${opts.website}/product/pump/`,
      sourcePath: 'test',
      transformRule: 'observed_name_restructured',
    },
  })
  return demoId
}

async function seedDiscovery(opts: {
  crmCompanyId: string
  companyName: string
  status: string
  candidates: Array<{ fullName: string; title: string; profileUrl: string }>
}): Promise<string> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const dmRunId = newId()
  await prisma.decisionMakerRun.create({
    data: {
      id: dmRunId,
      tenantId,
      crmCompanyId: opts.crmCompanyId,
      companyName: opts.companyName,
      requestedByCrmUserId: VIEWER.id,
      status: opts.status,
      candidateCount: opts.candidates.length,
      excludedCount: 0,
      providerResults: [{ provider: 'crm_contacts', status: 'available', reason: null }],
      completedAt: opts.status === 'completed' ? new Date() : null,
    },
  })
  let rank = 1
  for (const c of opts.candidates) {
    await prisma.decisionMakerCandidate.create({
      data: {
        id: newId(),
        tenantId,
        dmRunId,
        crmCompanyId: opts.crmCompanyId,
        identityKey: `${opts.crmCompanyId}:${c.fullName}`,
        fullName: c.fullName,
        rawTitle: c.title,
        normalizedTitle: c.title.toLowerCase(),
        roleGroup: 'ecommerce',
        rolePriority: 1,
        statedCompany: opts.companyName,
        companyMatch: 'verified',
        companyMatchReasons: ['Stated by the CRM contact record.'],
        profileUrl: c.profileUrl,
        confidence: 'high',
        confidenceReasons: ['One source stated the employment.'],
        contactability: 'profile_only',
        corroboratingProviders: ['crm_contacts'],
        corroborationCount: 1,
        rankScore: 100 - rank,
        rankReasons: ['Function owns product data.'],
        rank,
        outcome: 'shortlisted',
        evidence: [
          {
            provider: 'crm_contacts',
            sourceType: 'crm_record',
            sourceUrl: c.profileUrl,
            snippet: `contactPersons entry: ${c.fullName}, ${c.title}`,
            observedAt: new Date().toISOString(),
          },
        ],
      },
    })
    rank += 1
  }
  return dmRunId
}

beforeAll(async () => {
  if (skipReason) return
  const { prisma, newId } = await import('../../src/platform/db.js')
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  tenantId = tenant.id

  // "view" is all three routes ask for, so the weakest role proves the gate is
  // not accidentally stricter than the screens that call it.
  await prisma.tenantMember.upsert({
    where: { tenantId_email: { tenantId, email: VIEWER.email } },
    create: {
      id: newId(),
      tenantId,
      crmUserId: VIEWER.id,
      email: VIEWER.email,
      name: VIEWER.email,
      role: VIEWER.role,
    },
    update: { crmUserId: VIEWER.id, role: VIEWER.role },
  })

  const mine = await seedAudit({
    crmCompanyId: MINE,
    companyName: 'Contract Mine Ltd',
    website: 'https://mine-contract.test',
    reportStatus: 'approved',
    products: [
      { slug: 'pump', name: 'MINE Circulation Pump 42', sku: 'MIN-42' },
      { slug: 'valve', name: 'MINE Valve 7', sku: 'MIN-7' },
    ],
  })
  mineRun = mine.runId
  mineReport = mine.reportId
  mineProductPage = mine.pageIds[0]!
  await seedWorkbench({
    crmCompanyId: MINE,
    companyName: 'Contract Mine Ltd',
    website: 'https://mine-contract.test',
    runId: mineRun,
    reportId: mineReport,
    pageId: mineProductPage,
    productName: 'MINE Circulation Pump 42',
  })
  await seedDiscovery({
    crmCompanyId: MINE,
    companyName: 'Contract Mine Ltd',
    status: 'completed',
    candidates: [{ fullName: 'Mina Contract', title: 'Head of Ecommerce', profileUrl: 'https://mine-contract.test/team/mina' }],
  })

  // Reported, never demonstrated: the ONLY empty endpoint is the Workbench.
  const noWorkbench = await seedAudit({
    crmCompanyId: MINE,
    companyName: 'Contract Mine Ltd',
    website: 'https://mine-contract.test',
    reportStatus: 'ready_for_approval',
    products: [{ slug: 'hose', name: 'MINE Hose 3m', sku: 'MIN-3M' }],
  })
  mineNoWorkbenchRun = noWorkbench.runId

  // Queued and never crawled, and therefore never reported. This is the shape
  // that was rendering as a zero-valued executive summary.
  mineNoReportRun = newId()
  await prisma.websiteAuditRun.create({
    data: {
      id: mineNoReportRun,
      tenantId,
      crmCompanyId: MINE,
      requestedByCrmUserId: VIEWER.id,
      status: 'queued',
      pagesFetched: 0,
    },
  })

  // A second, fully populated company. Every leakage assertion below is only
  // meaningful because this data exists and could have been reached.
  const other = await seedAudit({
    crmCompanyId: OTHER,
    companyName: 'Contract Rival Ltd',
    website: 'https://rival-contract.test',
    reportStatus: 'approved',
    products: [{ slug: 'pump', name: 'RIVAL Bath Suite', sku: 'RIV-1' }],
  })
  otherRun = other.runId
  await seedWorkbench({
    crmCompanyId: OTHER,
    companyName: 'Contract Rival Ltd',
    website: 'https://rival-contract.test',
    runId: otherRun,
    reportId: other.reportId,
    pageId: other.pageIds[0]!,
    productName: 'RIVAL Bath Suite',
  })
  otherDmRun = await seedDiscovery({
    crmCompanyId: OTHER,
    companyName: 'Contract Rival Ltd',
    status: 'completed',
    candidates: [{ fullName: 'Rival Person', title: 'Head of Catalog', profileUrl: 'https://rival-contract.test/team/rival' }],
  })

  // Discovery queued and never finished — no COMPLETED run, so no candidates.
  await seedDiscovery({
    crmCompanyId: NEVER_COMPLETED,
    companyName: 'Contract Unfinished Ltd',
    status: 'queued',
    candidates: [],
  })

  const { createServer } = await import('../../src/server.js')
  const app = createServer()
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const addr = server.address()
  base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : ''
})

afterAll(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()))
  if (skipReason || !tenantId) return
  const { prisma } = await import('../../src/platform/db.js')
  // Swept by PREFIX rather than by this run's exact ids: a run that dies before
  // afterAll would otherwise leave fixture companies in the database forever.
  const debris = { crmCompanyId: { startsWith: 'apicontract-' } }
  await prisma.decisionMakerRun.deleteMany({ where: debris })
  await prisma.auditReport.deleteMany({ where: debris })
  await prisma.websiteAuditRun.deleteMany({ where: debris })
  await prisma.tenantMember.deleteMany({ where: { tenantId, email: { startsWith: 'apicontract-' } } })
})

describeIfReady('the paths the browser asks for are mounted', () => {
  it('answers an unknown path with the terminal handler’s fixed message', async () => {
    // The CONTROL. Everything else in this file asserts "not this", so this has
    // to be shown to be reachable — otherwise a deleted route would pass.
    const { newId } = await import('../../src/platform/db.js')
    for (const path of [
      `/api/v1/website-audit/runs/${newId()}/customer-view-typo`,
      `/api/v1/website-audit/runs/${newId()}/workbenchh`,
      `/api/v1/decision-makers/companies/${newId()}/candidates-typo`,
      '/api/v1/website-audit-typo/runs/x/customer-view',
    ]) {
      const r = await get(path, tokenFor(VIEWER))
      expect(r.status, path).toBe(404)
      expect(r.message, `${path} must reach the terminal 404, proving the control works`).toBe(UNMOUNTED_MESSAGE)
    }
  })

  it('GET /website-audit/runs/:id/customer-view exists', async () => {
    const { newId } = await import('../../src/platform/db.js')
    const r = await get(`/api/v1/website-audit/runs/${newId()}/customer-view`, tokenFor(VIEWER))
    expectMountedNotFound(r, /audit run/i)
  })

  it('GET /website-audit/runs/:id/workbench exists', async () => {
    const { newId } = await import('../../src/platform/db.js')
    const r = await get(`/api/v1/website-audit/runs/${newId()}/workbench`, tokenFor(VIEWER))
    expectMountedNotFound(r, /workbench/i)
  })

  it('GET /decision-makers/companies/:crmCompanyId/candidates exists', async () => {
    const { newId } = await import('../../src/platform/db.js')
    const r = await get(`/api/v1/decision-makers/companies/${newId()}/candidates`, tokenFor(VIEWER))
    expectMountedNotFound(r, /decision-maker/i)
  })

  it('answers 401, not 404, when the caller has no token', async () => {
    // A missing token must never look like a missing resource: the screen would
    // report "nothing built yet" for a session that had simply expired.
    for (const path of [
      `/api/v1/website-audit/runs/${mineRun}/customer-view`,
      `/api/v1/website-audit/runs/${mineRun}/workbench`,
      `/api/v1/decision-makers/companies/${MINE}/candidates`,
    ]) {
      const r = await get(path)
      expect(r.status, path).toBe(401)
    }
  })
})

describeIfReady('a built resource answers 200 with its own company and run', () => {
  it('customer-view carries the run it was asked about', async () => {
    const r = await get(`/api/v1/website-audit/runs/${mineRun}/customer-view`, tokenFor(VIEWER))
    expect(r.status).toBe(200)
    expect(r.body.crmCompanyId).toBe(MINE)
    expect(r.body.auditRunId).toBe(mineRun)
    expect(r.body.companyName).toBe('Contract Mine Ltd')
    expect(r.body.website).toBe('https://mine-contract.test')
    expect(r.body.reportStatus).toBe('approved')
    expect((r.body.caseStudies as unknown[]).length, 'a real story, not an empty shell').toBeGreaterThan(0)
  })

  it('workbench carries the demonstration built for that run', async () => {
    const r = await get(`/api/v1/website-audit/runs/${mineRun}/workbench`, tokenFor(VIEWER))
    expect(r.status).toBe(200)
    expect(r.body.auditRunId).toBe(mineRun)
    expect(r.body.crmCompanyId).toBe(MINE)
    expect(r.body.companyName).toBe('Contract Mine Ltd')
    expect(r.body.status).toBe('ready')
    expect((r.body.fields as unknown[]).length).toBeGreaterThan(0)
    expect(r.body.productImageUrl, 'derived from this run’s own page').toBe(
      'https://mine-contract.test/img/pump.jpg',
    )
  })

  it('candidates carries the newest COMPLETED run for that company', async () => {
    const r = await get(`/api/v1/decision-makers/companies/${MINE}/candidates`, tokenFor(VIEWER))
    expect(r.status).toBe(200)
    expect(r.body.crmCompanyId).toBe(MINE)
    expect(r.body.companyName).toBe('Contract Mine Ltd')
    expect(r.body.runId, 'a completed run, not a queued one').toBeTruthy()
    expect(r.body.total).toBe(1)
    const candidates = r.body.candidates as Array<Record<string, unknown>>
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.fullName).toBe('Mina Contract')
    expect(candidates[0]!.crmCompanyId).toBe(MINE)
  })
})

describeIfReady('no company can see another company’s record', () => {
  /** The second company's ids, names, hosts and people, in one list. */
  const rivalMarkers = () => [OTHER, otherRun, otherDmRun, 'rival-contract.test', 'RIVAL', 'Contract Rival Ltd', 'Rival Person']

  it('customer-view reaches nothing belonging to the other company', async () => {
    const r = await get(`/api/v1/website-audit/runs/${mineRun}/customer-view`, tokenFor(VIEWER))
    for (const marker of rivalMarkers()) expect(r.raw, marker).not.toContain(marker)

    for (const c of r.body.caseStudies as Array<Record<string, unknown>>) {
      expect(c.crmCompanyId).toBe(MINE)
      expect(c.auditRunId).toBe(mineRun)
      expect(new URL(String(c.sourceUrl)).hostname).toBe('mine-contract.test')
    }
  })

  it('workbench reaches nothing belonging to the other company', async () => {
    const r = await get(`/api/v1/website-audit/runs/${mineRun}/workbench`, tokenFor(VIEWER))
    for (const marker of rivalMarkers()) expect(r.raw, marker).not.toContain(marker)

    for (const f of r.body.fields as Array<Record<string, unknown>>) {
      if (f.sourceUrl) expect(new URL(String(f.sourceUrl)).hostname).toBe('mine-contract.test')
    }
  })

  it('candidates reaches nothing belonging to the other company', async () => {
    const r = await get(`/api/v1/decision-makers/companies/${MINE}/candidates`, tokenFor(VIEWER))
    for (const marker of rivalMarkers()) expect(r.raw, marker).not.toContain(marker)
  })

  it('gives the other company its own record when asked about it', async () => {
    // Isolation has to cut both ways, or the first three tests would also pass
    // against an endpoint that simply returned nothing.
    const view = await get(`/api/v1/website-audit/runs/${otherRun}/customer-view`, tokenFor(VIEWER))
    expect(view.status).toBe(200)
    expect(view.body.crmCompanyId).toBe(OTHER)
    expect(view.raw).not.toContain('mine-contract.test')

    const candidates = await get(`/api/v1/decision-makers/companies/${OTHER}/candidates`, tokenFor(VIEWER))
    expect(candidates.status).toBe(200)
    expect(candidates.body.crmCompanyId).toBe(OTHER)
    expect(candidates.raw).not.toContain('Mina Contract')
  })
})

describeIfReady('an empty state says what is missing, and says it in the envelope', () => {
  it('a run with a report but no Workbench: report 200, Workbench 404-with-envelope', async () => {
    // The two endpoints disagree, and that disagreement is the point: one
    // 404 among three 200s means "this one artifact has not been built",
    // never "this company has nothing".
    const view = await get(`/api/v1/website-audit/runs/${mineNoWorkbenchRun}/customer-view`, tokenFor(VIEWER))
    expect(view.status, 'the report exists and must still render').toBe(200)
    expect(view.body.auditRunId).toBe(mineNoWorkbenchRun)

    const bench = await get(`/api/v1/website-audit/runs/${mineNoWorkbenchRun}/workbench`, tokenFor(VIEWER))
    expectMountedNotFound(bench, /no workbench has been built/i)
  })

  it('a run that never produced a report says so, rather than reporting zeroes', async () => {
    // The A1 Building Supply shape: queued, never crawled, nothing to report.
    // A zero-valued executive summary here is worse than an honest refusal.
    const r = await get(`/api/v1/website-audit/runs/${mineNoReportRun}/customer-view`, tokenFor(VIEWER))
    expectMountedNotFound(r, /no report has been generated/i)
    expect(r.raw, 'no zero-valued report may be assembled instead').not.toContain('pagesInspected')
  })

  it('a company whose only discovery run never completed says so', async () => {
    const r = await get(`/api/v1/decision-makers/companies/${NEVER_COMPLETED}/candidates`, tokenFor(VIEWER))
    expectMountedNotFound(r, /no completed decision-maker discovery run/i)
    expect(r.raw, 'an unfinished run is not an empty shortlist').not.toContain('"candidates"')
  })

  it('every empty state is distinguishable from every other, by message alone', async () => {
    const { newId } = await import('../../src/platform/db.js')
    const messages = [
      (await get(`/api/v1/website-audit/runs/${mineNoReportRun}/customer-view`, tokenFor(VIEWER))).message,
      (await get(`/api/v1/website-audit/runs/${mineNoWorkbenchRun}/workbench`, tokenFor(VIEWER))).message,
      (await get(`/api/v1/decision-makers/companies/${NEVER_COMPLETED}/candidates`, tokenFor(VIEWER))).message,
      (await get(`/api/v1/website-audit/runs/${newId()}/customer-view-typo`, tokenFor(VIEWER))).message,
    ]
    // A client that only sees the status code cannot tell these apart, which is
    // why the message is part of the contract and not decoration.
    expect(new Set(messages).size, messages.join(' | ')).toBe(messages.length)
  })
})
