import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import jwt from 'jsonwebtoken'

// TASK #986 — THE HUMAN APPROVAL API.
//
// These run against the REAL Express app on an ephemeral port, through the real
// authenticate + requirePermission middleware. Nothing is stubbed except the
// HTTP transport out to NXT Sales, so a route that forgot its permission gate,
// or trusted a body it should not, fails here rather than in production.
//
// NOTHING REACHES NXT SALES. Outbound GETs go to the local CRM; the PUT is
// captured at the transport and never sent. The checked-in CRM_WRITE_ENABLED
// stays false and is overridden for this process only.

const envMock: Record<string, unknown> = { CRM_WRITE_ENABLED: true }
vi.mock('../../src/config/env.js', async (orig) => {
  const actual = (await orig()) as { env: Record<string, unknown> }
  return { env: new Proxy(envMock, { get: (t, k: string) => (k in t ? t[k] : actual.env[k]) }) }
})

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
if (skipReason) console.warn(`\n[crmApprovalApi] SKIPPED — ${skipReason}\n`)

/** Three distinct people, so identity and policy are actually separable. */
const REQUESTER = { id: 'test-requester-id', email: 'requester@altiusnxt.test', role: 'approver' }
const APPROVER = { id: 'test-approver-id', email: 'approver@altiusnxt.test', role: 'approver' }
const OPERATOR = { id: 'test-operator-id', email: 'operator@altiusnxt.test', role: 'operator' }

const sent: Array<{ method: string; url: string; body: unknown }> = []
const puts = () => sent.filter((s) => s.method === 'PUT')

let server: Server
let base = ''
let tenantId = ''
let company = ''
let qualificationId = ''
let syncId = ''

function tokenFor(u: { id: string; email: string }): string {
  // Signed with the same secret the app verifies with — a genuine token, not a
  // stubbed principal, so the real middleware is under test.
  return jwt.sign({ id: u.id, email: u.email, name: u.email }, process.env.JWT_SECRET!, { expiresIn: 300 })
}

/** The error handler answers { error: { code, message, ... } }. */
function errorMessage(body: Record<string, unknown>): string {
  const e = body.error as { message?: string } | undefined
  return e?.message ?? ''
}

async function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Record<string, unknown>; message: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status, body, message: errorMessage(body) }
}

/** Puts the handoff back in front of a reviewer between tests. */
async function reopen(): Promise<string> {
  const { prisma } = await import('../../src/platform/db.js')
  await prisma.crmSyncRecord.update({ where: { id: syncId }, data: { state: 'awaiting_user_approval' } })
  const r = await prisma.crmSyncRecord.findUniqueOrThrow({ where: { id: syncId } })
  return r.updatedAt.toISOString()
}

beforeAll(async () => {
  if (skipReason) return
  const { prisma, newId } = await import('../../src/platform/db.js')
  const { ensureDefaultPolicy: ensureScorePolicy } = await import('../../src/intentscore/service.js')
  const { ensureDefaultPolicy: ensureQualPolicy } = await import('../../src/salesqualification/service.js')

  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  tenantId = tenant.id
  company = `task986api-${Date.now().toString(36)}`

  for (const u of [REQUESTER, APPROVER, OPERATOR]) {
    await prisma.tenantMember.upsert({
      where: { tenantId_email: { tenantId, email: u.email } },
      create: { id: newId(), tenantId, crmUserId: u.id, email: u.email, name: u.email, role: u.role },
      update: { crmUserId: u.id, role: u.role },
    })
  }

  const scorePolicy = await ensureScorePolicy()
  const qualPolicy = await ensureQualPolicy()
  const runId = newId()
  await prisma.websiteAuditRun.create({
    data: { id: runId, tenantId, crmCompanyId: company, requestedByCrmUserId: REQUESTER.id, status: 'completed' },
  })
  const reportId = newId()
  await prisma.auditReport.create({
    data: {
      id: reportId,
      tenantId,
      auditRunId: runId,
      crmCompanyId: company,
      auditDate: new Date(),
      status: 'approved',
      currentRevision: 1,
      approvedRevision: 1,
      reviewedAt: new Date(),
    },
  })
  await prisma.auditReportRevision.create({
    data: { id: newId(), tenantId, auditReportId: reportId, auditRunId: runId, revisionNumber: 1, content: {}, validationOk: true },
  })
  await prisma.intentScore.create({
    data: {
      id: newId(),
      tenantId,
      crmCompanyId: company,
      rawScore: 100,
      normalizedScore: 100,
      level: 'HIGH',
      policyVersion: scorePolicy.version,
      policyStatus: scorePolicy.status,
      calculationVersion: 'calc-1',
      evaluatedAt: new Date(),
      resultHash: 'fixture-approval-api',
    },
  })
  qualificationId = newId()
  await prisma.salesQualification.create({
    data: {
      id: qualificationId,
      tenantId,
      crmCompanyId: company,
      companyName: 'Approval API Fixture',
      status: 'qualified_unassigned',
      scoreAtQualification: 100,
      thresholdAtQualification: qualPolicy.threshold,
      differenceAtQualification: 100 - qualPolicy.threshold,
      scorePolicyVersion: scorePolicy.version,
      scoreCalculationVersion: 'calc-1',
      scoreEvaluatedAt: new Date(),
      qualificationPolicyVersion: qualPolicy.version,
      qualificationEngineVersion: 'qual-1',
      reason: 'Fixture for the approval API.',
      ownerCrmUserId: null,
      ownerSource: 'none',
      qualifiedAt: new Date(),
    },
  })

  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    const url = String(input)
    // Requests to our own test server, and all reads, go through untouched.
    if (method === 'GET' || url.startsWith(base)) return realFetch(input as never, init)
    sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null })
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })

  // Prepared BY the requester, so the self-approval policy has two identities
  // to tell apart.
  const { syncQualification } = await import('../../src/crmsync/service.js')
  await syncQualification({ tenantId, qualificationId, actorCrmUserId: REQUESTER.id })
  const rec = await prisma.crmSyncRecord.findFirstOrThrow({ where: { tenantId, qualificationId } })
  syncId = rec.id

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
  vi.unstubAllGlobals()
  if (skipReason || !company) return
  const { prisma } = await import('../../src/platform/db.js')
  // Swept by PREFIX, not by this run's exact id: a run that dies before
  // afterAll would otherwise leave a fixture sitting in the pending queue.
  const debris = { crmCompanyId: { startsWith: 'task986api-' } }
  await prisma.salesQualification.deleteMany({ where: debris })
  await prisma.intentScore.deleteMany({ where: debris })
  await prisma.websiteAuditRun.deleteMany({ where: debris })
  await prisma.tenantMember.deleteMany({
    where: { tenantId, email: { in: [REQUESTER.email, APPROVER.email, OPERATOR.email] } },
  })
})

describeIfReady('CRM approval API — authentication and authorisation', () => {
  it('refuses an unauthenticated request on every endpoint', async () => {
    for (const [method, path] of [
      ['GET', '/api/v1/crm-sync/approvals/pending'],
      ['POST', `/api/v1/crm-sync/approvals/${syncId}/approve`],
      ['POST', `/api/v1/crm-sync/approvals/${syncId}/reject`],
    ] as const) {
      const r = await call(method, path, { body: method === 'POST' ? { expectedUpdatedAt: new Date().toISOString() } : undefined })
      expect(r.status, `${method} ${path}`).toBe(401)
    }
    expect(puts(), 'an unauthenticated call must not write').toHaveLength(0)
  })

  it('refuses a garbage token', async () => {
    const r = await call('GET', '/api/v1/crm-sync/approvals/pending', { token: 'not-a-real-token' })
    expect(r.status).toBe(401)
  })

  it('refuses a caller without the approve permission', async () => {
    const at = await reopen()
    const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(OPERATOR),
      body: { expectedUpdatedAt: at },
    })
    expect(r.status).toBe(403)
    expect(r.message).toMatch(/approve/)
    expect(puts()).toHaveLength(0)
  })
})

describeIfReady('CRM approval API — the pending queue', () => {
  it('lists the handoff waiting for a decision', async () => {
    await reopen()
    const r = await call('GET', '/api/v1/crm-sync/approvals/pending', { token: tokenFor(APPROVER) })
    expect(r.status).toBe(200)
    const mine = (r.body.pending as Array<Record<string, unknown>>).find((x) => x.syncId === syncId)
    expect(mine, 'the pending handoff must be listed').toBeTruthy()
    expect(mine!.state).toBe('awaiting_user_approval')
    expect(mine!.requestedByCrmUserId).toBe(REQUESTER.id)
    expect(mine!.expectedUpdatedAt).toBeTruthy()
  })

  it('returns only what a reviewer needs, not the evidence chain', async () => {
    const r = await call('GET', '/api/v1/crm-sync/approvals/pending', { token: tokenFor(APPROVER) })
    const mine = (r.body.pending as Array<Record<string, unknown>>).find((x) => x.syncId === syncId)!
    // A reviewer gets company, score, status, owner, validation — and no
    // payload, no findings, no contributions, no decision-maker records.
    for (const leaked of ['payload', 'findings', 'contributions', 'decisionMaker', 'workbench', 'evidence']) {
      expect(Object.keys(mine), leaked).not.toContain(leaked)
    }
    expect(JSON.stringify(r.body)).not.toMatch(/secret|apiKey|Bearer |password/i)
  })
})

describeIfReady('CRM approval API — approving', () => {
  it('reaches approveSync and delivers exactly one PUT', async () => {
    const at = await reopen()
    sent.length = 0
    const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at, note: 'Checked the evidence.' },
    })
    expect(r.status).toBe(200)
    expect(r.body.decision).toBe('approved')
    expect(r.body.state).toBe('synced')
    expect(r.body.decidedByCrmUserId).toBe(APPROVER.id)
    expect(puts()).toHaveLength(1)
  })

  it('records the approver from the token, not the body', async () => {
    const at = await reopen()
    sent.length = 0
    // A caller trying to sign the decision as somebody else.
    const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at, approvedByCrmUserId: 'somebody-else', crmUserId: 'somebody-else' },
    })
    // Rejected outright rather than silently ignored: the body is `.strict()`.
    expect(r.status).toBe(400)
    expect(puts()).toHaveLength(0)

    const { prisma } = await import('../../src/platform/db.js')
    const spoofed = await prisma.auditEvent.findFirst({
      where: { tenantId, resourceId: syncId, actorCrmUserId: 'somebody-else' },
    })
    expect(spoofed, 'no audit entry may name the spoofed approver').toBeNull()
  })

  it('refuses a body that tries to set the CRM payload', async () => {
    const at = await reopen()
    sent.length = 0
    for (const bad of [
      { expectedUpdatedAt: at, intentScore: 5 },
      { expectedUpdatedAt: at, qualificationStatus: 'Qualified' },
      { expectedUpdatedAt: at, customFields: { intentScore: 5 } },
      { expectedUpdatedAt: at, ownerId: 'someone' },
    ]) {
      const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
        token: tokenFor(APPROVER),
        body: bad,
      })
      expect(r.status, JSON.stringify(bad)).toBe(400)
    }
    expect(puts(), 'nothing may be written by a rejected body').toHaveLength(0)
  })

  it('refuses a stale decision', async () => {
    await reopen()
    sent.length = 0
    const stale = new Date(Date.now() - 60_000).toISOString()
    const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: stale },
    })
    expect(r.status).toBe(409)
    expect(r.message).toMatch(/changed since you loaded it/)
    expect(puts()).toHaveLength(0)
  })

  it('refuses a handoff that has already been decided', async () => {
    const at = await reopen()
    sent.length = 0
    const first = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at },
    })
    expect(first.status).toBe(200)

    const { prisma } = await import('../../src/platform/db.js')
    const now = await prisma.crmSyncRecord.findUniqueOrThrow({ where: { id: syncId } })
    const second = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: now.updatedAt.toISOString() },
    })
    expect(second.status).toBe(409)
    expect(puts(), 'a second approval must not write again').toHaveLength(1)
  })

  it('refuses the person who prepared it', async () => {
    const at = await reopen()
    sent.length = 0
    const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(REQUESTER),
      body: { expectedUpdatedAt: at },
    })
    expect(r.status).toBe(403)
    expect(r.message).toMatch(/cannot also approve it/)
    expect(puts()).toHaveLength(0)
  })

  it('404s an unknown handoff without revealing anything', async () => {
    const r = await call('POST', '/api/v1/crm-sync/approvals/does-not-exist/approve', {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: new Date().toISOString() },
    })
    expect(r.status).toBe(404)
  })
})

describeIfReady('CRM approval API — rejecting', () => {
  it('reaches rejectSync and writes nothing', async () => {
    const at = await reopen()
    sent.length = 0
    const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/reject`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at, reason: 'The audit evidence is out of date.' },
    })
    expect(r.status).toBe(200)
    expect(r.body.decision).toBe('rejected')
    expect(r.body.state).toBe('rejected_by_user')
    expect(r.body.decidedByCrmUserId).toBe(APPROVER.id)
    expect(puts(), 'a rejection must never write').toHaveLength(0)
  })

  it('requires a reason', async () => {
    const at = await reopen()
    const r = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/reject`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at },
    })
    expect(r.status).toBe(400)
  })

  it('refuses a rejection of an already-decided handoff', async () => {
    const at = await reopen()
    const first = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/reject`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at, reason: 'Not this quarter.' },
    })
    expect(first.status).toBe(200)

    const { prisma } = await import('../../src/platform/db.js')
    const now = await prisma.crmSyncRecord.findUniqueOrThrow({ where: { id: syncId } })
    const second = await call('POST', `/api/v1/crm-sync/approvals/${syncId}/reject`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: now.updatedAt.toISOString(), reason: 'Again.' },
    })
    expect(second.status).toBe(409)
  })
})

describeIfReady('CRM approval API — the audit trail', () => {
  it('records identity, decision, timestamp and the qualification', async () => {
    const at = await reopen()
    await call('POST', `/api/v1/crm-sync/approvals/${syncId}/approve`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at, note: 'Evidence reviewed.' },
    })

    const { prisma } = await import('../../src/platform/db.js')
    const entry = await prisma.auditEvent.findFirst({
      where: { tenantId, resourceId: syncId, action: 'crm_sync.approved_by_user' },
      orderBy: { createdAt: 'desc' },
    })
    expect(entry, 'an approval must be audited').toBeTruthy()
    expect(entry!.actorType).toBe('user')
    expect(entry!.actorCrmUserId).toBe(APPROVER.id)
    expect(entry!.createdAt).toBeInstanceOf(Date)
    expect((entry!.metadata as { qualificationId?: string }).qualificationId).toBe(qualificationId)
  })

  it('keeps the trail append-only across repeated decisions', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const before = await prisma.auditEvent.count({ where: { tenantId, resourceId: syncId } })
    const at = await reopen()
    await call('POST', `/api/v1/crm-sync/approvals/${syncId}/reject`, {
      token: tokenFor(APPROVER),
      body: { expectedUpdatedAt: at, reason: 'Changed my mind.' },
    })
    const after = await prisma.auditEvent.count({ where: { tenantId, resourceId: syncId } })
    expect(after, 'earlier entries are never replaced').toBeGreaterThan(before)
  })
})

describeIfReady('CRM approval API — no automated approval', () => {
  it('the background worker cannot approve', async () => {
    const fs = await import('node:fs')
    const worker = fs.readFileSync(new URL('../../src/worker.ts', import.meta.url), 'utf8')
    expect(worker).not.toContain('approveSync')
    expect(worker).not.toContain('userApproval')
  })

  it('approveSync is the only supplier of an approval, and only routes call it', async () => {
    const fs = await import('node:fs')
    const service = fs.readFileSync(new URL('../../src/crmsync/service.ts', import.meta.url), 'utf8')
    // One place constructs a userApproval object: approveSync itself.
    const constructions = service.split('userApproval: {').length - 1
    expect(constructions, 'only approveSync may construct an approval').toBe(1)
  })
})
