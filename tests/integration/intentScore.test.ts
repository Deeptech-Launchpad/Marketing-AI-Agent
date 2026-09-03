import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// TASK #984 integration tests, over the REAL Task #983 engagement history.
//
// The events these score are the ones a real visit to the 1st Ayd Workbench
// produced. Nothing external is contacted, no CRM row is touched, and no
// outreach happens — scoring reads engagement and writes scores.

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
if (skipReason) console.warn(`\n[intentScore] SKIPPED — ${skipReason}\n`)

let tenantId = ''
/** A disposable company id, so these tests never disturb a real score. */
const COMPANY = `task984-integration-${Date.now().toString(36)}`
const createdEventIds: string[] = []

/** Writes an engagement event directly, bypassing the capture path. */
async function seed(
  eventType: string,
  channel: string,
  occurredAt: Date,
  sessionRef = 'itest-session',
  company = COMPANY,
): Promise<string> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const id = newId()
  await prisma.engagementEvent.create({
    data: {
      id,
      tenantId,
      crmCompanyId: company,
      companyName: 'Task 984 Integration Fixture',
      eventType,
      channel,
      source: eventType.startsWith('workbench') || eventType.startsWith('audit') ? 'workbench_app' : 'outreach_engine',
      occurredAt,
      receivedAt: occurredAt,
      freshnessLabel: 'fresh',
      ageHours: 0,
      sessionRef,
      dedupeKey: `itest-${id}`,
      processingStatus: 'recorded',
      evidence: { what: `fixture ${eventType}`, where: null, how: 'seeded by the Task #984 integration test', referenceKind: null, referenceId: null },
      metadata: {},
    },
  })
  createdEventIds.push(id)
  return id
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
  // Contributions cascade from both the snapshot and the event.
  await prisma.intentScore.deleteMany({ where: { crmCompanyId: { startsWith: 'task984-integration-' } } })
  await prisma.intentScoreSnapshot.deleteMany({ where: { crmCompanyId: { startsWith: 'task984-integration-' } } })
  await prisma.engagementEvent.deleteMany({ where: { crmCompanyId: { startsWith: 'task984-integration-' } } })
  await prisma.intentScoringPolicy.deleteMany({ where: { version: { startsWith: 'itest-' } } })
})

describeIfReady('Task #984 — the real 1st Ayd engagement history', () => {
  it('1. scores the live 1st Ayd events', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')

    const real = await prisma.engagementEvent.findFirst({
      where: { tenantId, source: 'workbench_app' },
      select: { crmCompanyId: true },
    })
    if (!real) return

    const result = await scoreCompany({
      tenantId,
      crmCompanyId: real.crmCompanyId,
      persist: false,
    })

    expect(result.eventsConsidered).toBeGreaterThan(0)
    expect(result.normalizedScore).toBeGreaterThanOrEqual(0)
    expect(result.normalizedScore).toBeLessThanOrEqual(100)
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(result.level)
    expect(result.policyStatus).toBe('provisional')

    // Every point traces to a real event row.
    const ids = result.contributions.map((c) => c.engagementEventId)
    const found = await prisma.engagementEvent.count({ where: { id: { in: ids } } })
    expect(found).toBe(ids.length)
  })
})

describeIfReady('Task #984 — the eight required cases', () => {
  it('2. a company with no engagement scores zero', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const r = await scoreCompany({ tenantId, crmCompanyId: `${COMPANY}-empty`, persist: false })
    expect(r.normalizedScore).toBe(0)
    expect(r.level).toBe('LOW')
    expect(r.eventsConsidered).toBe(0)
    expect(r.contributions).toEqual([])
  })

  it('3. only-AltiusNXT events contribute nothing', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const company = `${COMPANY}-ours`
    const at = new Date()
    await seed('email_sent', 'email', at, 'x', company)
    await seed('call_task_created', 'call', at, 'x', company)
    await seed('outreach_action_blocked', 'linkedin', at, 'x', company)

    const r = await scoreCompany({ tenantId, crmCompanyId: company, persist: false })
    expect(r.eventsConsidered).toBe(3)
    expect(r.normalizedScore).toBe(0)
    expect(r.eventsScored).toBe(0)
    // Present in the breakdown with a reason, not silently dropped.
    expect(r.contributions.length).toBe(3)
  })

  it('4. positive prospect events raise the score', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const company = `${COMPANY}-positive`
    const at = new Date()
    await seed('workbench_registration_completed', 'workbench', at, 's1', company)
    await seed('workbench_cta_clicked', 'workbench', at, 's1', company)

    const r = await scoreCompany({ tenantId, crmCompanyId: company, persist: false })
    expect(r.rawScore).toBe(45)
    expect(r.level).toBe('MEDIUM')
  })

  it('5. a negative event lowers it, and a bounce does not', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const at = new Date()

    const unsub = `${COMPANY}-unsub`
    await seed('workbench_cta_clicked', 'workbench', at, 's1', unsub)
    await seed('email_unsubscribed', 'email', at, 's1', unsub)
    const a = await scoreCompany({ tenantId, crmCompanyId: unsub, persist: false })
    expect(a.rawScore).toBe(-5)
    expect(a.normalizedScore).toBe(0)
    expect(a.contactability.status).toBe('blocked')

    const bounced = `${COMPANY}-bounce`
    await seed('workbench_cta_clicked', 'workbench', at, 's1', bounced)
    await seed('email_bounced', 'email', at, 's1', bounced)
    const b = await scoreCompany({ tenantId, crmCompanyId: bounced, persist: false })
    // A delivery failure is a contactability fact, never an interest penalty.
    expect(b.rawScore).toBe(25)
    expect(b.contactability.status).toBe('degraded')
  })

  it('6. a repeated low-value event cannot inflate the score', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const company = `${COMPANY}-repeat`
    // Seeded in the PAST. A score is calculated "as of" an instant and ignores
    // anything after it, so future-dated fixtures would simply not be seen.
    const base = Date.now() - 3_600_000
    for (let i = 0; i < 30; i++) {
      await seed('workbench_viewed', 'workbench', new Date(base + i * 1000), 's1', company)
    }
    const r = await scoreCompany({ tenantId, crmCompanyId: company, persist: false })
    expect(r.eventsConsidered).toBe(30)
    // Thirty reloads in one visit is one viewing's worth of evidence.
    expect(r.rawScore).toBe(10)
    expect(r.eventsScored).toBe(1)
  })

  it('7. an old event contributes less, or nothing', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const company = `${COMPANY}-old`
    const asOf = new Date('2026-08-28T12:00:00Z')
    await seed('workbench_cta_clicked', 'workbench', new Date('2026-03-01T12:00:00Z'), 's1', company)

    const r = await scoreCompany({ tenantId, crmCompanyId: company, asOf, persist: false })
    expect(r.rawScore).toBe(0)
    expect(r.contributions[0]!.freshnessMultiplier).toBe(0)
    expect(r.contributions[0]!.ageDays).toBeGreaterThan(31)
  })

  it('8. two separate acts of the same type both count, up to the cap', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const company = `${COMPANY}-dupe`
    const base = Date.now() - 3_600_000
    // Task #983 recorded these as two distinct acts; Task #984 does not add a
    // second layer of deduplication on top of that decision.
    await seed('workbench_comparison_used', 'workbench', new Date(base), 's1', company)
    await seed('workbench_comparison_used', 'workbench', new Date(base + 60_000), 's1', company)

    const r = await scoreCompany({ tenantId, crmCompanyId: company, persist: false })
    expect(r.eventsScored).toBe(2)
    expect(r.rawScore).toBe(30)
  })

  it('9. mixed positive and negative events net out', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const company = `${COMPANY}-mixed`
    const at = new Date()
    await seed('workbench_registration_completed', 'workbench', at, 's1', company)
    await seed('workbench_cta_clicked', 'workbench', at, 's1', company)
    await seed('workbench_evidence_viewed', 'workbench', at, 's1', company)
    await seed('email_sent', 'email', at, 's1', company)
    await seed('email_bounced', 'email', at, 's1', company)
    await seed('email_unsubscribed', 'email', at, 's1', company)

    const r = await scoreCompany({ tenantId, crmCompanyId: company, persist: false })
    // 20 + 25 + 10 - 30 = 25. The sent email and the bounce contribute nothing.
    expect(r.rawScore).toBe(25)
    expect(r.contactability.status).toBe('blocked')
    expect(r.eventsConsidered).toBe(6)
  })
})

/** Shared by the persistence and boundary suites below. */
const HISTORY_COMPANY = `${COMPANY}-history`

describeIfReady('Task #984 — persistence, history and determinism', () => {
  const company = HISTORY_COMPANY

  it('10. persists a score, a snapshot and a full breakdown', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const at = new Date()
    await seed('workbench_link_opened', 'workbench', at, 'h1', company)
    await seed('workbench_registration_completed', 'workbench', at, 'h1', company)

    const r = await scoreCompany({ tenantId, crmCompanyId: company, trigger: 'initial' })
    expect(r.snapshotId).toBeTruthy()

    const stored = await prisma.intentScore.findUnique({
      where: { tenantId_crmCompanyId: { tenantId, crmCompanyId: company } },
    })
    expect(stored?.normalizedScore).toBe(30)
    expect(stored?.latestSnapshotId).toBe(r.snapshotId)

    const contributions = await prisma.intentScoreContribution.findMany({ where: { snapshotId: r.snapshotId! } })
    expect(contributions.length).toBe(2)
    for (const c of contributions) {
      expect(c.engagementEventId).toBeTruthy()
      expect(c.policyVersion).toBe(r.policyVersion)
    }
  })

  it('11. recalculation is idempotent and adds no duplicate history', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')

    const before = await prisma.intentScoreSnapshot.count({ where: { tenantId, crmCompanyId: company } })
    const again = await scoreCompany({ tenantId, crmCompanyId: company })
    const after = await prisma.intentScoreSnapshot.count({ where: { tenantId, crmCompanyId: company } })

    expect(again.unchanged).toBe(true)
    expect(after).toBe(before)
  })

  it('12. new engagement produces a new snapshot with the change recorded', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')

    await seed('workbench_cta_clicked', 'workbench', new Date(), 'h1', company)
    const r = await scoreCompany({ tenantId, crmCompanyId: company })
    expect(r.unchanged).toBe(false)
    expect(r.normalizedScore).toBe(55)

    const snapshot = await prisma.intentScoreSnapshot.findUniqueOrThrow({ where: { id: r.snapshotId! } })
    expect(snapshot.deltaFromPrevious).toBe(25)

    const history = await prisma.intentScoreSnapshot.findMany({
      where: { tenantId, crmCompanyId: company },
      orderBy: { createdAt: 'asc' },
    })
    expect(history.length).toBe(2)
    expect(history.map((h) => h.normalizedScore)).toEqual([30, 55])
  })

  it('13. a historical asOf reproduces the same score every time', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const asOf = new Date('2026-08-28T12:00:00Z')
    const historyCompany = `${COMPANY}-asof`
    await seed('workbench_cta_clicked', 'workbench', new Date('2026-08-25T09:00:00Z'), 'a1', historyCompany)

    const first = await scoreCompany({ tenantId, crmCompanyId: historyCompany, asOf, persist: false })
    const second = await scoreCompany({ tenantId, crmCompanyId: historyCompany, asOf, persist: false })

    expect(second.normalizedScore).toBe(first.normalizedScore)
    expect(second.resultHash).toBe(first.resultHash)
    // 3 days old: 25 * 0.8.
    expect(first.normalizedScore).toBe(20)
  })

  it('14. an event after the evaluation instant is not counted', async () => {
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const c = `${COMPANY}-future`
    await seed('workbench_cta_clicked', 'workbench', new Date('2026-08-20T09:00:00Z'), 'f1', c)
    await seed('workbench_registration_completed', 'workbench', new Date('2026-08-27T09:00:00Z'), 'f1', c)

    const early = await scoreCompany({
      tenantId,
      crmCompanyId: c,
      asOf: new Date('2026-08-21T12:00:00Z'),
      persist: false,
    })
    // A score "as of" the 21st cannot see the 27th. Only the CTA click of the
    // 20th is in scope, aged one day, so it keeps its full 25.
    expect(early.eventsConsidered).toBe(1)
    expect(early.rawScore).toBe(25)

    // Scored later, both events are in scope and both have aged.
    const later = await scoreCompany({
      tenantId,
      crmCompanyId: c,
      asOf: new Date('2026-08-28T12:00:00Z'),
      persist: false,
    })
    expect(later.eventsConsidered).toBe(2)
    // CTA 8 days old (25 * 0.5 = 13) + registration 1 day old (20 * 1.0).
    expect(later.rawScore).toBe(33)
  })

  it('15. a different policy version produces a separate, labelled calculation', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')
    const { DEFAULT_POLICY } = await import('../../src/intentscore/policy.js')

    const version = 'itest-v2'
    await prisma.intentScoringPolicy.create({
      data: {
        id: newId(),
        version,
        status: 'provisional',
        description: 'Integration test policy with doubled weights.',
        minScore: 0,
        maxScore: 100,
        rules: DEFAULT_POLICY.rules.map((r) => ({ ...r, points: r.points * 2 })) as never,
        decayBands: DEFAULT_POLICY.decayBands as never,
        levelBands: DEFAULT_POLICY.levelBands as never,
        scoringActors: DEFAULT_POLICY.scoringActors as never,
        notes: ['Integration test only.'] as never,
      },
    })

    const c = `${COMPANY}-policy`
    await seed('workbench_cta_clicked', 'workbench', new Date(), 'p1', c)

    const v1 = await scoreCompany({ tenantId, crmCompanyId: c, persist: false })
    const v2 = await scoreCompany({ tenantId, crmCompanyId: c, policyVersion: version, persist: false })

    expect(v1.rawScore).toBe(25)
    expect(v2.rawScore).toBe(50)
    expect(v2.policyVersion).toBe(version)
    // The older calculation stays reproducible under its own version.
    const again = await scoreCompany({ tenantId, crmCompanyId: c, persist: false })
    expect(again.rawScore).toBe(25)
  })

  it('16. is isolated by tenant', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')

    const other = await prisma.tenant.create({
      data: { id: newId(), slug: `itest-984-${Date.now().toString(36)}`, name: 'Task 984 isolation test' },
    })
    try {
      // The same company id, scored under a tenant that has none of its events.
      const r = await scoreCompany({ tenantId: other.id, crmCompanyId: company, persist: false })
      expect(r.eventsConsidered).toBe(0)
      expect(r.normalizedScore).toBe(0)
    } finally {
      await prisma.tenant.delete({ where: { id: other.id } })
    }
  })
})

describeIfReady('Task #984 — the traceability guarantee', () => {
  it('17. no stored contribution exists without a valid engagement event', async () => {
    const { prisma } = await import('../../src/platform/db.js')

    // Mechanical, over every contribution in the database — not just the ones
    // this file created.
    const orphaned = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n
         FROM marketing."IntentScoreContribution" c
         LEFT JOIN marketing."EngagementEvent" e ON e.id = c."engagementEventId"
        WHERE e.id IS NULL`,
    )
    expect(Number(orphaned[0]!.n)).toBe(0)
  })

  it('18. the database refuses a contribution with no event', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const snapshot = await prisma.intentScoreSnapshot.findFirstOrThrow({
      where: { crmCompanyId: { startsWith: 'task984-integration-' } },
    })

    // The foreign key is what makes the guarantee structural rather than a
    // convention someone could forget.
    await expect(
      prisma.intentScoreContribution.create({
        data: {
          id: newId(),
          tenantId,
          snapshotId: snapshot.id,
          engagementEventId: 'no-such-event-id',
          eventType: 'workbench_cta_clicked',
          channel: 'workbench',
          occurredAt: new Date(),
          ruleId: 'r.fake',
          basePoints: 25,
          freshnessMultiplier: 1,
          freshnessLabel: 'x',
          ageDays: 0,
          adjustedPoints: 25,
          reason: 'should never be stored',
          policyVersion: 'v1-provisional',
        },
      }),
    ).rejects.toThrow()
  })

  it('19. deleting an event removes the points it produced', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')

    const c = `${COMPANY}-cascade`
    const eventId = await seed('workbench_cta_clicked', 'workbench', new Date(), 'c1', c)
    const r = await scoreCompany({ tenantId, crmCompanyId: c })

    expect(await prisma.intentScoreContribution.count({ where: { snapshotId: r.snapshotId! } })).toBe(1)
    await prisma.engagementEvent.delete({ where: { id: eventId } })
    // A point whose evidence is gone must not survive as a number nobody can
    // explain.
    expect(await prisma.intentScoreContribution.count({ where: { snapshotId: r.snapshotId! } })).toBe(0)
  })
})

describeIfReady('Task #984 — boundaries', () => {
  it('20. writes nothing to NXT Sales', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const crm = getCrm()
    const writeish = Object.keys(Object.getPrototypeOf(crm) as object).filter((m) =>
      /^(create|update|delete|write|save|patch|post|upsert)/i.test(m),
    )
    expect(writeish).toEqual([])
  })

  // Scoped to this file's own company id, not a global count. The integration
  // files run in parallel, so a global before/after would be measuring the
  // other suites rather than this one. The airtight guarantee is the source
  // scan in the unit tests, which proves the module never calls these APIs at
  // all; these two are the behavioural confirmation.

  it('21. creates no outreach action while scoring', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')

    const where = { tenantId, crmCompanyId: HISTORY_COMPANY }
    const before = await prisma.outreachAction.count({ where })
    await scoreCompany({ tenantId, crmCompanyId: HISTORY_COMPANY })
    expect(await prisma.outreachAction.count({ where })).toBe(before)
    expect(before).toBe(0)
  })

  it('22. creates no engagement event while scoring, so it cannot loop', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { scoreCompany } = await import('../../src/intentscore/service.js')

    const where = { tenantId, crmCompanyId: HISTORY_COMPANY }
    const before = await prisma.engagementEvent.count({ where })
    await scoreCompany({ tenantId, crmCompanyId: HISTORY_COMPANY })
    // Scoring reads engagement and writes scores. If it wrote an event, that
    // event would trigger another score, and the loop would not terminate.
    expect(await prisma.engagementEvent.count({ where })).toBe(before)
  })
})
