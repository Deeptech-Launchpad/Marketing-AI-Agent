import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// TASK #985 integration tests, over the REAL Task #984 scores.
//
// Nothing here contacts a prospect, sends a message, or writes to NXT Sales.
// The strongest thing these tests cause is a row in our own database.

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
if (skipReason) console.warn(`\n[salesQualification] SKIPPED — ${skipReason}\n`)

let tenantId = ''
const PREFIX = `task985-${Date.now().toString(36)}`

/**
 * Gives a disposable company a score of exactly `value`.
 *
 * Writes an IntentScore directly rather than engineering engagement events to
 * land on a number — the point of these tests is the THRESHOLD behaviour, and
 * Task #984's own suite already proves the arithmetic.
 */
async function seedScore(company: string, value: number): Promise<void> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const { ensureDefaultPolicy } = await import('../../src/intentscore/service.js')
  const policy = await ensureDefaultPolicy()

  const snapshotId = newId()
  await prisma.intentScoreSnapshot.create({
    data: {
      id: snapshotId,
      tenantId,
      crmCompanyId: company,
      rawScore: value,
      normalizedScore: value,
      level: value >= 70 ? 'HIGH' : value >= 30 ? 'MEDIUM' : 'LOW',
      policyVersion: policy.version,
      policyStatus: policy.status,
      calculationVersion: 'calc-1',
      evaluatedAt: new Date(),
      resultHash: `itest-${company}-${value}`,
      trigger: 'recalculation',
    },
  })

  const fields = {
    tenantId,
    crmCompanyId: company,
    companyName: 'Task 985 Fixture',
    rawScore: value,
    normalizedScore: value,
    level: value >= 70 ? 'HIGH' : value >= 30 ? 'MEDIUM' : 'LOW',
    policyVersion: policy.version,
    policyStatus: policy.status,
    calculationVersion: 'calc-1',
    evaluatedAt: new Date(),
    resultHash: `itest-${company}-${value}`,
    latestSnapshotId: snapshotId,
  }

  await prisma.intentScore.upsert({
    where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    create: { id: newId(), ...fields },
    update: fields,
  })
}

beforeAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  tenantId = tenant.id
})

afterAll(async () => {
  if (skipReason) return
  const { prisma } = await import('../../src/platform/db.js')
  const where = { crmCompanyId: { startsWith: PREFIX } }
  // Alerts, tasks and history all cascade from the qualification.
  await prisma.salesQualification.deleteMany({ where })
  await prisma.intentScore.deleteMany({ where })
  await prisma.intentScoreSnapshot.deleteMany({ where })
})

describeIfReady('Task #985 — threshold behaviour on real scores', () => {
  it('1. the real 1st Ayd score qualifies as a high-intent lead', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')

    const real = await prisma.intentScore.findFirst({
      where: { tenantId, normalizedScore: { gte: 70 }, crmCompanyId: { not: { startsWith: 'task98' } } },
      orderBy: { normalizedScore: 'desc' },
    })
    if (!real) return

    const r = await evaluateCompany({ tenantId, crmCompanyId: real.crmCompanyId, dryRun: true })

    expect(r.score).toBe(real.normalizedScore)
    expect(r.threshold).toBe(70)
    expect(['qualified', 'qualified_unassigned']).toContain(r.status)
    expect(r.reason).toContain(String(real.normalizedScore))
    // The evidence is REFERENCED from Task #984, never recreated.
    for (const e of r.evidence) expect(e.engagementEventId).toBeTruthy()
  })

  it('2. a company below the threshold is not qualified', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const c = `${PREFIX}-low`
    await seedScore(c, 40)
    const r = await evaluateCompany({ tenantId, crmCompanyId: c })
    expect(r.status).toBe('not_qualified')
    expect(r.difference).toBe(-30)
    expect(r.alertStatus).toBe('pending')
    expect(r.taskStatus).toBe('pending')
  })

  it('3. a company with no score cannot be qualified, and says why', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const r = await evaluateCompany({ tenantId, crmCompanyId: `${PREFIX}-nothing` })
    expect(r.blocker).toBe('no_intent_score')
    expect(r.status).toBe('not_qualified')
    expect(r.reason).toMatch(/no intent score/i)
    // Nothing was invented to fill the gap.
    expect(r.qualificationId).toBeNull()
  })

  it('4. a score exactly at the threshold qualifies', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const c = `${PREFIX}-exact`
    await seedScore(c, 70)
    const r = await evaluateCompany({ tenantId, crmCompanyId: c })
    expect(r.status === 'qualified' || r.status === 'qualified_unassigned').toBe(true)
    expect(r.difference).toBe(0)
  })

  it('5. one point below does not qualify', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const c = `${PREFIX}-below`
    await seedScore(c, 69)
    const r = await evaluateCompany({ tenantId, crmCompanyId: c })
    expect(r.status).toBe('not_qualified')
  })

  it('6. one point above qualifies', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const c = `${PREFIX}-above`
    await seedScore(c, 71)
    const r = await evaluateCompany({ tenantId, crmCompanyId: c })
    expect(r.status === 'qualified' || r.status === 'qualified_unassigned').toBe(true)
  })
})

describeIfReady('Task #985 — the handoff', () => {
  const company = `${PREFIX}-handoff`

  it('7. resolves an owner honestly, and never guesses one', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    await seedScore(company, 85)
    const r = await evaluateCompany({ tenantId, crmCompanyId: company })

    // This fixture company does not exist in NXT Sales, so no owner can be
    // found. The lead is reported unassigned rather than routed to somebody.
    expect(r.owner.resolved).toBe(false)
    expect(r.owner.crmUserId).toBeNull()
    expect(r.owner.source).toBe('none')
    expect(r.status).toBe('qualified_unassigned')
    expect(r.owner.reason.length).toBeGreaterThan(20)
  })

  it('8. records an alert with no owner as skipped, never as sent', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const q = await prisma.salesQualification.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    })
    const alert = await prisma.salesAlert.findFirstOrThrow({ where: { qualificationId: q.id } })

    expect(alert.status).toBe('skipped_no_owner')
    expect(alert.delivered).toBe(false)
    expect(q.alertStatus).toBe('skipped_no_owner')
  })

  it('9. records a follow-up task with no owner as skipped', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const q = await prisma.salesQualification.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    })
    const task = await prisma.salesFollowUpTask.findFirstOrThrow({ where: { qualificationId: q.id } })
    expect(task.status).toBe('skipped_no_owner')
    expect(q.taskStatus).toBe('skipped_no_owner')
  })

  it('10. keeps qualification, alert and task as three separate statuses', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const q = await prisma.salesQualification.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    })
    // Qualified, but nothing was delivered. One collapsed status could not say
    // this, which is exactly why there are three.
    expect(q.status).toBe('qualified_unassigned')
    expect(q.alertStatus).toBe('skipped_no_owner')
    expect(q.taskStatus).toBe('skipped_no_owner')
  })

  it('11. snapshots the score and threshold onto the decision', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const q = await prisma.salesQualification.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    })
    expect(q.scoreAtQualification).toBe(85)
    expect(q.thresholdAtQualification).toBe(70)
    expect(q.differenceAtQualification).toBe(15)
    expect(q.scorePolicyVersion).toBe('v1-provisional')
    expect(q.scoreCalculationVersion).toBe('calc-1')
    expect(q.qualificationPolicyVersion).toBe('sq1-provisional')
    expect(q.qualifiedAt).toBeTruthy()
    expect(q.dueAt).toBeTruthy()
    // The SLA was applied: 15 minutes after qualification.
    expect(q.dueAt!.getTime() - q.qualifiedAt!.getTime()).toBe(15 * 60_000)
  })
})

describeIfReady('Task #985 — idempotency and duplicate execution', () => {
  const company = `${PREFIX}-idem`

  it('12. a repeated evaluation creates no second alert or task', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')

    await seedScore(company, 90)
    await evaluateCompany({ tenantId, crmCompanyId: company })

    const q = await prisma.salesQualification.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    })
    const alertsBefore = await prisma.salesAlert.count({ where: { qualificationId: q.id } })
    const tasksBefore = await prisma.salesFollowUpTask.count({ where: { qualificationId: q.id } })

    // Three more times, as a redelivered worker job would.
    await evaluateCompany({ tenantId, crmCompanyId: company })
    await evaluateCompany({ tenantId, crmCompanyId: company })
    await evaluateCompany({ tenantId, crmCompanyId: company })

    expect(await prisma.salesAlert.count({ where: { qualificationId: q.id } })).toBe(alertsBefore)
    expect(await prisma.salesFollowUpTask.count({ where: { qualificationId: q.id } })).toBe(tasksBefore)
    expect(alertsBefore).toBe(1)
    expect(tasksBefore).toBe(1)
  })

  it('13. a repeated evaluation adds no history noise', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')

    const before = await prisma.salesQualificationHistory.count({ where: { tenantId, crmCompanyId: company } })
    const r = await evaluateCompany({ tenantId, crmCompanyId: company })
    const after = await prisma.salesQualificationHistory.count({ where: { tenantId, crmCompanyId: company } })

    expect(r.unchanged).toBe(true)
    expect(after).toBe(before)
  })
})

describeIfReady('Task #985 — re-qualification and de-qualification', () => {
  const company = `${PREFIX}-moves`

  it('14. a score crossing the threshold qualifies the lead', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')

    await seedScore(company, 65)
    const low = await evaluateCompany({ tenantId, crmCompanyId: company })
    expect(low.status).toBe('not_qualified')

    await seedScore(company, 72)
    const high = await evaluateCompany({ tenantId, crmCompanyId: company })
    expect(high.status === 'qualified' || high.status === 'qualified_unassigned').toBe(true)
    expect(high.previousStatus).toBe('not_qualified')
  })

  it('15. a score later falling below the threshold de-qualifies it', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    await seedScore(company, 68)
    const r = await evaluateCompany({ tenantId, crmCompanyId: company })
    expect(r.status).toBe('de_qualified')
    expect(r.reason).toMatch(/fallen below/i)
  })

  it('16. the earlier qualification survives in the history', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const rows = await prisma.salesQualificationHistory.findMany({
      where: { tenantId, crmCompanyId: company },
      orderBy: { occurredAt: 'asc' },
    })

    const transitions = rows.map((r) => r.transition)
    expect(transitions).toContain('qualified')
    expect(transitions).toContain('de_qualified')
    // Append-only: the qualification that happened is still on the record.
    const qualified = rows.find((r) => r.transition === 'qualified')!
    expect(qualified.newScore).toBe(72)
    expect(qualified.threshold).toBe(70)
  })

  it('17. re-qualifies when the score recovers', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const { prisma } = await import('../../src/platform/db.js')

    await seedScore(company, 88)
    const r = await evaluateCompany({ tenantId, crmCompanyId: company })
    expect(r.status === 'qualified' || r.status === 'qualified_unassigned').toBe(true)
    expect(r.previousStatus).toBe('de_qualified')

    const rows = await prisma.salesQualificationHistory.findMany({
      where: { tenantId, crmCompanyId: company },
      orderBy: { occurredAt: 'asc' },
    })
    expect(rows.map((x) => x.transition)).toContain('re_qualified')
  })

  it('18. does not cancel an existing task on de-qualification by default', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const q = await prisma.salesQualification.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    })
    const cancelled = await prisma.salesFollowUpTask.count({
      where: { qualificationId: q.id, completionStatus: 'cancelled' },
    })
    // Somebody may already be acting on it. The policy can reverse this.
    expect(cancelled).toBe(0)
  })
})

describeIfReady('Task #985 — provider availability, reported honestly', () => {
  it('19. reports the CRM task provider as unavailable, not as a failure to hide', async () => {
    const { CrmTaskProvider } = await import('../../src/salesqualification/providers/taskProvider.js')
    const a = new CrmTaskProvider().availability()
    // Verified against the LIVE port, not asserted from memory.
    expect(a.status).toBe('not_configured')
    expect(a.reason).toMatch(/read-only/i)
  })

  it('20. records which providers were skipped and why', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const task = await prisma.salesFollowUpTask.findFirst({
      where: { crmCompanyId: { startsWith: PREFIX }, providerName: 'internal' },
    })
    if (!task) return
    const skipped = task.skipped as Array<{ name: string; reason: string }> | null
    expect(skipped?.some((s) => s.name === 'nxt_sales')).toBe(true)
  })

  it('21. the CRM port still exposes no write method at all', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const crm = getCrm()
    const writeish = Object.keys(Object.getPrototypeOf(crm) as object).filter((m) =>
      /^(create|update|delete|write|save|patch|post|upsert)/i.test(m),
    )
    expect(writeish).toEqual([])
  })
})

describeIfReady('Task #985 — security and isolation', () => {
  it('22. is isolated by tenant', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')

    const other = await prisma.tenant.create({
      data: { id: newId(), slug: `itest-985-${Date.now().toString(36)}`, name: 'Task 985 isolation test' },
    })
    try {
      // The same company id, under a tenant that has no score for it.
      const r = await evaluateCompany({ tenantId: other.id, crmCompanyId: `${PREFIX}-idem` })
      expect(r.blocker).toBe('no_intent_score')
      expect(r.status).toBe('not_qualified')
    } finally {
      await prisma.tenant.delete({ where: { id: other.id } })
    }
  })

  it('23. loads the score and threshold from trusted records, never from a caller', async () => {
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const c = `${PREFIX}-trust`
    await seedScore(c, 42)

    // The options a caller can influence carry no score, threshold, owner or
    // status — there is nowhere to put one.
    const r = await evaluateCompany({ tenantId, crmCompanyId: c })
    expect(r.score).toBe(42)
    expect(r.threshold).toBe(70)
    expect(r.status).toBe('not_qualified')
  })
})

describeIfReady('Task #985 — nothing reaches a prospect', () => {
  it('24. creates no outreach action while qualifying', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const c = `${PREFIX}-idem`

    const where = { crmCompanyId: c }
    const before = await prisma.outreachAction.count({ where })
    await evaluateCompany({ tenantId, crmCompanyId: c })
    expect(await prisma.outreachAction.count({ where })).toBe(before)
    expect(before).toBe(0)
  })

  it('25. modifies no intent score and no engagement event', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { evaluateCompany } = await import('../../src/salesqualification/service.js')
    const c = `${PREFIX}-idem`

    const scoreBefore = await prisma.intentScore.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: c } },
    })
    const snapshotsBefore = await prisma.intentScoreSnapshot.count({ where: { crmCompanyId: c } })
    const eventsBefore = await prisma.engagementEvent.count({ where: { crmCompanyId: c } })

    await evaluateCompany({ tenantId, crmCompanyId: c })

    const scoreAfter = await prisma.intentScore.findUniqueOrThrow({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: c } },
    })
    expect(scoreAfter.normalizedScore).toBe(scoreBefore.normalizedScore)
    expect(scoreAfter.updatedAt.getTime()).toBe(scoreBefore.updatedAt.getTime())
    expect(await prisma.intentScoreSnapshot.count({ where: { crmCompanyId: c } })).toBe(snapshotsBefore)
    expect(await prisma.engagementEvent.count({ where: { crmCompanyId: c } })).toBe(eventsBefore)
  })
})
