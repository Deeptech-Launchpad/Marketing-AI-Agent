import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// TASK #986 — THE APPROVED CRM WRITE, END TO END.
//
// This is the test whose absence let B1 ship. Unit tests exercised crmPut and
// updateCompany directly and passed; the integration suite asserted the
// pre-write-path behaviour and passed. Nothing traversed the actual chain:
//
//   approveSync -> syncQualification -> attemptDelivery -> provider.update
//     -> updateCompany -> assertWritable -> crmPut -> PUT /api/companies/:id
//
// So the two gates that made that chain unreachable were invisible to the suite.
//
// ─────────────────────────────────────────────────────────────────────────────
// NOTHING REACHES NXT SALES.
//
// GETs are delegated to the real local CRM, so the package is assembled exactly
// the way production assembles it. The PUT is intercepted at the transport, its
// body recorded, and a synthetic 200 returned — it is never sent. The
// checked-in CRM_WRITE_ENABLED stays false; it is overridden for this process
// only, because a write path that is switched off cannot be proven correct.
//
// THE FIXTURE. A CRM package must carry an intent score and an APPROVED audit
// report naming a revision that resolves, and validation refuses it otherwise —
// correctly. So the fixture builds that whole evidence chain under a company id
// of its own, rather than borrowing a real lead: the one real qualified company
// in this database already holds a sync record, and a test that rewrites real
// state to prove a point is a test that has changed the thing it measured.
// Everything seeded here is deleted afterwards.

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
if (skipReason) console.warn(`\n[crmApprovedWrite] SKIPPED — ${skipReason}\n`)

/** Every non-GET the platform attempted. Populated by the transport stub. */
type Sent = { method: string; url: string; body: Record<string, unknown> | null }
const sent: Sent[] = []
const puts = (): Sent[] => sent.filter((s) => s.method === 'PUT')

let tenantId = ''
let company = ''
let qualificationId = ''

/** The confirmed live mapping for a lead qualified with no owner assigned. */
const EXPECTED_STATUS = 'Qualified - Unassigned'
const APPROVER = 'cmt8ljfon00top3t31zkt33wz'

const SCORE = 100

/** The complete evidence chain a CRM package is required to carry. */
async function seedEvidenceChain(): Promise<void> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const { ensureDefaultPolicy: ensureScorePolicy } = await import('../../src/intentscore/service.js')
  const { ensureDefaultPolicy: ensureQualPolicy } = await import('../../src/salesqualification/service.js')
  const scorePolicy = await ensureScorePolicy()
  const qualPolicy = await ensureQualPolicy()

  const runId = newId()
  await prisma.websiteAuditRun.create({
    data: {
      id: runId,
      tenantId,
      crmCompanyId: company,
      companyName: 'Approved Write Fixture',
      requestedByCrmUserId: APPROVER,
      status: 'completed',
    },
  })

  const reportId = newId()
  await prisma.auditReport.create({
    data: {
      id: reportId,
      tenantId,
      auditRunId: runId,
      crmCompanyId: company,
      companyName: 'Approved Write Fixture',
      auditDate: new Date(),
      // Approved, and naming the revision that carries the approval.
      status: 'approved',
      currentRevision: 1,
      approvedRevision: 1,
      reviewedAt: new Date(),
    },
  })

  await prisma.auditReportRevision.create({
    data: {
      id: newId(),
      tenantId,
      auditReportId: reportId,
      auditRunId: runId,
      revisionNumber: 1,
      content: {},
      validationOk: true,
    },
  })

  await prisma.intentScore.create({
    data: {
      id: newId(),
      tenantId,
      crmCompanyId: company,
      companyName: 'Approved Write Fixture',
      rawScore: SCORE,
      normalizedScore: SCORE,
      level: 'HIGH',
      policyVersion: scorePolicy.version,
      policyStatus: scorePolicy.status,
      calculationVersion: 'calc-1',
      evaluatedAt: new Date(),
      resultHash: 'fixture-approved-write',
    },
  })

  qualificationId = newId()
  await prisma.salesQualification.create({
    data: {
      id: qualificationId,
      tenantId,
      crmCompanyId: company,
      companyName: 'Approved Write Fixture',
      // No owner, so this exercises the confirmed "Qualified - Unassigned"
      // dropdown value — the exact string the live field was configured with.
      status: 'qualified_unassigned',
      scoreAtQualification: SCORE,
      thresholdAtQualification: qualPolicy.threshold,
      differenceAtQualification: SCORE - qualPolicy.threshold,
      scorePolicyVersion: scorePolicy.version,
      scoreCalculationVersion: 'calc-1',
      scoreEvaluatedAt: new Date(),
      qualificationPolicyVersion: qualPolicy.version,
      qualificationEngineVersion: 'qual-1',
      reason: `The current intent score of ${SCORE} meets the configured high-intent threshold of ${qualPolicy.threshold}.`,
      ownerCrmUserId: null,
      ownerSource: 'none',
      qualifiedAt: new Date(),
    },
  })
}

beforeAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  tenantId = tenant.id
  company = `task986w-${Date.now().toString(36)}`
  await seedEvidenceChain()

  const realFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const method = String(init?.method ?? 'GET').toUpperCase()
    // Reads go to the real local CRM. Writes stop here.
    if (method === 'GET') return realFetch(input as never, init)
    sent.push({
      method,
      url: String(input),
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    })
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  })
})

afterAll(async () => {
  vi.unstubAllGlobals()
  if (skipReason || !company) return
  const { prisma } = await import('../../src/platform/db.js')
  // Sync records, attempts and outbox entries cascade from the qualification;
  // report revisions cascade from the report, and the report from the run.
  // Swept by PREFIX, not by this run's exact id: a run that dies before
  // afterAll would otherwise leave a fixture sitting in the pending queue.
  const debris = { crmCompanyId: { startsWith: 'task986w-' } }
  await prisma.salesQualification.deleteMany({ where: debris })
  await prisma.intentScore.deleteMany({ where: debris })
  await prisma.websiteAuditRun.deleteMany({ where: debris })
})

describeIfReady('Task #986 — approveSync reaches the approved update', () => {
  let syncRecordId = ''
  let expectedScore = 0

  it('1. holds an unapproved handoff at the human gate, writing nothing', async () => {
    expect(company, 'no company with a complete evidence chain to test against').toBeTruthy()

    const { buildPayload } = await import('../../src/crmsync/payload.js')
    const built = await buildPayload({ tenantId, qualificationId })
    expectedScore = built!.payload.intent.score ?? 0

    const { syncQualification } = await import('../../src/crmsync/service.js')
    const r = await syncQualification({ tenantId, qualificationId })

    // The gate the business asked for: validated, deliverable, and waiting.
    expect(r.validation.ok, JSON.stringify(r.validation.issues)).toBe(true)
    expect(r.state).toBe('awaiting_user_approval')
    expect(puts(), 'an unapproved handoff must not write').toHaveLength(0)

    const { prisma } = await import('../../src/platform/db.js')
    const rec = await prisma.crmSyncRecord.findFirstOrThrow({ where: { tenantId, qualificationId } })
    syncRecordId = rec.id
    expect(rec.state).toBe('awaiting_user_approval')
  })

  it('2. reaches provider.update -> updateCompany -> exactly one PUT on approval', async () => {
    const { approveSync } = await import('../../src/crmsync/service.js')
    const r = await approveSync(tenantId, syncRecordId, APPROVER, 'Reviewed and approved.')

    expect(r.state).toBe('synced')
    const outcome = r.resources.find((x) => x.resource === 'company')
    expect(outcome?.result, 'the company resource must report an update').toBe('updated')
    expect(outcome?.externalId).toBe(company)

    expect(puts(), 'exactly one PUT').toHaveLength(1)
    expect(puts()[0]!.url).toBe(`${process.env.NXT_SALES_BASE_URL}/api/companies/${company}`)
  })

  it('3. sends ONLY the two approved custom fields', async () => {
    const body = puts()[0]!.body!
    expect(Object.keys(body)).toEqual(['customFields'])
    expect(body).toEqual({
      customFields: {
        intentScore: expectedScore,
        qualificationStatus: EXPECTED_STATUS,
      },
    })
  })

  it('4. sends no forbidden field, at any depth', async () => {
    const FORBIDDEN = [
      'ownerId',
      'leadStatus',
      'name',
      'industry',
      'domain',
      'email',
      'phone',
      'remarks',
      'country',
      'stage',
      'dealStage',
      'dealValue',
      'amount',
      'value',
      'owner',
      'dealId',
      'closeDate',
      'currency',
    ]
    const body = puts()[0]!.body!
    const keys: string[] = []
    const walk = (v: unknown): void => {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
          keys.push(k)
          walk(child)
        }
      }
    }
    walk(body)
    for (const f of FORBIDDEN) expect(keys, `"${f}" must never be sent`).not.toContain(f)
    // Belt and braces: no Deal field can be smuggled through as a value either.
    expect(JSON.stringify(body).toLowerCase()).not.toContain('deal')
  })

  it('5. a second approval is refused and writes nothing more', async () => {
    const { approveSync } = await import('../../src/crmsync/service.js')
    await expect(approveSync(tenantId, syncRecordId, APPROVER)).rejects.toThrow(/not awaiting a decision/)
    expect(puts(), 'no second PUT').toHaveLength(1)
  })

  it('6. re-syncing an already-synced lead reuses the result without writing', async () => {
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const again = await syncQualification({ tenantId, qualificationId })
    expect(again.reused).toBe(true)
    expect(again.state).toBe('synced')
    expect(puts(), 'idempotent: still one PUT').toHaveLength(1)
  })

  it('7. never issued any verb other than GET and that single PUT', async () => {
    const verbs = [...new Set(sent.map((s) => s.method))]
    expect(verbs).toEqual(['PUT'])
    expect(sent).toHaveLength(1)
  })
})
