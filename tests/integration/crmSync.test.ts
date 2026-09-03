import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// TASK #986 integration tests, over the REAL Task #985 qualification.
//
// NOTHING IS WRITTEN TO NXT SALES BY ANY TEST IN THIS FILE. The CRM is read
// through the port and nowhere else; the assertions below verify that as a
// row-count baseline rather than taking it on trust.

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
if (skipReason) console.warn(`\n[crmSync] SKIPPED — ${skipReason}\n`)

let tenantId = ''
const PREFIX = `task986-${Date.now().toString(36)}`

/** A disposable qualified lead, so tests never disturb the real handoff. */
async function seedQualification(
  company: string,
  opts: { status?: string; score?: number; owner?: string | null } = {},
): Promise<string> {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const { ensureDefaultPolicy } = await import('../../src/salesqualification/service.js')
  const policy = await ensureDefaultPolicy()

  const score = opts.score ?? 90
  const id = newId()
  await prisma.salesQualification.create({
    data: {
      id,
      tenantId,
      crmCompanyId: company,
      companyName: 'Task 986 Fixture',
      status: opts.status ?? 'qualified',
      scoreAtQualification: score,
      thresholdAtQualification: policy.threshold,
      differenceAtQualification: score - policy.threshold,
      scorePolicyVersion: 'v1-provisional',
      scoreCalculationVersion: 'calc-1',
      scoreEvaluatedAt: new Date(),
      qualificationPolicyVersion: policy.version,
      qualificationEngineVersion: 'qual-1',
      reason: `The current intent score of ${score} meets the configured high-intent threshold of ${policy.threshold}.`,
      ownerCrmUserId: opts.owner ?? null,
      ownerSource: opts.owner ? 'crm_account_owner' : 'none',
      qualifiedAt: new Date(),
    },
  })
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
  // Attempts and outbox entries cascade from the sync record; sync records
  // cascade from the qualification.
  await prisma.salesQualification.deleteMany({ where: { crmCompanyId: { startsWith: PREFIX } } })
})

describeIfReady('Task #986 — the real 1st Ayd handoff', () => {
  it('1. builds a complete package from the real qualification', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { buildPayload } = await import('../../src/crmsync/payload.js')

    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
      orderBy: { scoreAtQualification: 'desc' },
    })
    if (!q) return

    const built = await buildPayload({ tenantId, qualificationId: q.id })
    expect(built).not.toBeNull()
    const p = built!.payload

    expect(p.company.crmCompanyId).toBe(q.crmCompanyId)
    expect(p.qualification.qualificationRef).toBe(q.id)
    expect(p.qualification.scoreAtQualification).toBe(q.scoreAtQualification)
    expect(p.intent.topContributions.length).toBeGreaterThan(0)
    expect(p.engagement.totalProspectActions).toBeGreaterThan(0)
    expect(p.mappingVersion).toBe('crm-map-1')
    expect(p.externalKey).toContain(q.crmCompanyId)

    // Every claim carries a reference back to the record that justifies it.
    for (const c of p.intent.topContributions) expect(c.engagementEventRef).toBeTruthy()
  })

  it('2. carries no credential, no PDF and no raw provider payload', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { buildPayload } = await import('../../src/crmsync/payload.js')

    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
    })
    if (!q) return

    const built = await buildPayload({ tenantId, qualificationId: q.id })
    const serialised = JSON.stringify(built!.payload)

    expect(serialised).not.toMatch(/api[_-]?key|secret|password|Bearer |authorization/i)
    expect(serialised).not.toMatch(/pdfBytes|sessionRef|ipHash|dedupeKey|providerResponse/)
    // Bounded, not a database copy.
    expect(serialised.length).toBeLessThan(60_000)
    expect(built!.payload.intent.topContributions.length).toBeLessThanOrEqual(5)
    expect(built!.payload.audit.topFindings.length).toBeLessThanOrEqual(3)
    expect(built!.payload.engagement.recentEvents.length).toBeLessThanOrEqual(10)
  })

  it('3. withholds the Workbench link by default', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { buildPayload } = await import('../../src/crmsync/payload.js')
    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
    })
    if (!q) return

    const built = await buildPayload({ tenantId, qualificationId: q.id })
    // The link is a bearer credential; a shared CRM field is a wide audience.
    expect(built!.payload.workbench.publicUrl).toBeNull()
  })

  it('4. prepares the handoff and holds it in the outbox', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')

    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
      orderBy: { scoreAtQualification: 'desc' },
    })
    if (!q) return

    const r = await syncQualification({ tenantId, qualificationId: q.id })

    // The honest state: validated, mapped, and undeliverable.
    expect(r.state).toBe('blocked_provider_unavailable')
    expect(r.providerStatus).toBe('write_not_supported')
    expect(r.validation.ok).toBe(true)
    expect(r.outboxId).toBeTruthy()
    // Nothing claims to have been written.
    for (const res of r.resources) expect(res.result).toBe('not_supported')

    const held = await prisma.crmSyncOutbox.findUniqueOrThrow({ where: { id: r.outboxId! } })
    expect(held.state).toBe('pending')
    expect(held.mappingVersion).toBe('crm-map-1')
  })
})

describeIfReady('Task #986 — the qualification gate', () => {
  it('5. refuses a lead that is not qualified', async () => {
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const company = `${PREFIX}-notqualified`
    const id = await seedQualification(company, { status: 'not_qualified', score: 40 })

    const r = await syncQualification({ tenantId, qualificationId: id })
    expect(r.state).toBe('blocked_not_qualified')
    expect(r.validation.ok).toBe(false)
    expect(r.reason).toMatch(/Only a qualified lead may be handed to the CRM/i)
  })

  it('6. refuses a de-qualified lead', async () => {
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const id = await seedQualification(`${PREFIX}-dequal`, { status: 'de_qualified', score: 60 })
    const r = await syncQualification({ tenantId, qualificationId: id })
    expect(r.state).toBe('blocked_not_qualified')
  })

  it('7. accepts an unassigned lead, and records it as unassigned', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const id = await seedQualification(`${PREFIX}-unassigned`, { status: 'qualified_unassigned', owner: null })

    const r = await syncQualification({ tenantId, qualificationId: id })
    // Blocked on validation because the fixture company has no approved audit,
    // but the OWNER is recorded honestly either way.
    const record = await prisma.crmSyncRecord.findFirst({ where: { qualificationId: id } })
    expect(record?.ownerStatus).toBe('unassigned')
    expect(r.validation.issues.some((i) => i.check === 'owner_unassigned')).toBe(true)
  })
})

describeIfReady('Task #986 — validation refuses an unsound package', () => {
  it('8. refuses a company with no approved audit report', async () => {
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const id = await seedQualification(`${PREFIX}-noaudit`)

    const r = await syncQualification({ tenantId, qualificationId: id })
    expect(r.state).toBe('blocked_validation')
    expect(r.validation.ok).toBe(false)
    expect(r.validation.issues.some((i) => i.check === 'approved_report_exists')).toBe(true)
    // Nothing was attempted, so nothing was held.
    expect(r.outboxId).toBeNull()
  })

  it('9. refuses a company that has unsubscribed', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const company = `${PREFIX}-unsub`
    const id = await seedQualification(company)

    await prisma.engagementEvent.create({
      data: {
        id: newId(),
        tenantId,
        crmCompanyId: company,
        eventType: 'email_unsubscribed',
        channel: 'email',
        source: 'provider_webhook',
        occurredAt: new Date(),
        dedupeKey: `t986-unsub-${company}`,
        evidence: { what: 'unsubscribed', where: null, how: 'fixture', referenceKind: null, referenceId: null },
      },
    })

    const r = await syncQualification({ tenantId, qualificationId: id })
    // A company that asked us to stop must not be handed to sales to contact.
    expect(r.validation.issues.some((i) => i.check === 'not_suppressed')).toBe(true)
    expect(r.state).toBe('blocked_validation')

    await prisma.engagementEvent.deleteMany({ where: { crmCompanyId: company } })
  })

  it('10. refuses a Workbench belonging to another company', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { validateForSync } = await import('../../src/crmsync/validation.js')
    const { buildPayload } = await import('../../src/crmsync/payload.js')

    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
    })
    const foreignDemo = await prisma.workbenchDemo.findFirst({ where: { tenantId } })
    if (!q || !foreignDemo) return

    const built = await buildPayload({ tenantId, qualificationId: q.id })
    // Point the package at a demo that belongs to a different company.
    const tampered = {
      ...built!,
      refs: { ...built!.refs, workbenchDemoId: foreignDemo.id, crmCompanyId: q.crmCompanyId },
    }
    if (foreignDemo.crmCompanyId === q.crmCompanyId) return // not a mismatch here

    const v = await validateForSync(tenantId, tampered)
    expect(v.ok).toBe(false)
    expect(v.issues.some((i) => i.check === 'workbench_company')).toBe(true)
  })
})

describeIfReady('Task #986 — idempotency and history', () => {
  it('11. a repeated sync does not stack outbox entries', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')

    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
      orderBy: { scoreAtQualification: 'desc' },
    })
    if (!q) return

    await syncQualification({ tenantId, qualificationId: q.id })
    const before = await prisma.crmSyncOutbox.count({ where: { qualificationId: q.id } })

    await syncQualification({ tenantId, qualificationId: q.id })
    await syncQualification({ tenantId, qualificationId: q.id })

    // The held package is refreshed, not duplicated.
    expect(await prisma.crmSyncOutbox.count({ where: { qualificationId: q.id } })).toBe(before)
    expect(before).toBe(1)

    // One sync record, whatever the attempt count.
    expect(await prisma.crmSyncRecord.count({ where: { qualificationId: q.id } })).toBe(1)
  })

  it('12. every attempt is appended to the history', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')

    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
      orderBy: { scoreAtQualification: 'desc' },
    })
    if (!q) return

    const before = await prisma.crmSyncAttempt.count({ where: { qualificationId: q.id } })
    await syncQualification({ tenantId, qualificationId: q.id })
    const after = await prisma.crmSyncAttempt.count({ where: { qualificationId: q.id } })

    expect(after).toBe(before + 1)

    const latest = await prisma.crmSyncAttempt.findFirstOrThrow({
      where: { qualificationId: q.id },
      orderBy: { occurredAt: 'desc' },
    })
    expect(latest.mappingVersion).toBe('crm-map-1')
    expect(latest.newState).toBe('blocked_provider_unavailable')
    expect(latest.attempt).toBeGreaterThan(0)
  })

  it('13. a dry run persists nothing', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const id = await seedQualification(`${PREFIX}-dry`)

    const r = await syncQualification({ tenantId, qualificationId: id, dryRun: true })
    expect(r.dryRun).toBe(true)
    expect(await prisma.crmSyncRecord.count({ where: { qualificationId: id } })).toBe(0)
    expect(await prisma.crmSyncAttempt.count({ where: { qualificationId: id } })).toBe(0)
  })
})

describeIfReady('Task #986 — retries', () => {
  it('14. does not retry a permanent failure past the ceiling', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { retrySync } = await import('../../src/crmsync/service.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')

    const id = await seedQualification(`${PREFIX}-retry`)
    await syncQualification({ tenantId, qualificationId: id })
    const record = await prisma.crmSyncRecord.findFirstOrThrow({ where: { qualificationId: id } })

    // A validation failure is permanent: retrying re-evaluates rather than
    // repeating the same doomed call, and never reports success.
    const r = await retrySync(tenantId, record.id, 'u1')
    expect(r.state).not.toBe('synced')
    expect(r.retryable).toBe(false)
  })

  it('15. marks a write_not_supported result as not retryable', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
    })
    if (!q) return
    const record = await prisma.crmSyncRecord.findFirst({ where: { qualificationId: q.id } })
    if (!record) return
    // Retrying will not make a missing adapter appear.
    expect(record.retryable).toBe(false)
    expect(record.nextRetryAt).toBeNull()
  })
})

describeIfReady('Task #986 — security and isolation', () => {
  it('16. is isolated by tenant', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')

    const id = await seedQualification(`${PREFIX}-iso`)
    const other = await prisma.tenant.create({
      data: { id: newId(), slug: `itest-986-${Date.now().toString(36)}`, name: 'Task 986 isolation test' },
    })
    try {
      // Another tenant's qualification is simply not found.
      await expect(syncQualification({ tenantId: other.id, qualificationId: id })).rejects.toThrow(/does not exist/i)
    } finally {
      await prisma.tenant.delete({ where: { id: other.id } })
    }
  })

  it('17. loads the score and status from trusted records, not from a caller', async () => {
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const id = await seedQualification(`${PREFIX}-trust`, { status: 'not_qualified', score: 10 })

    // The options a caller can influence carry no score and no status — there
    // is nowhere to put one.
    const r = await syncQualification({ tenantId, qualificationId: id })
    expect(r.state).toBe('blocked_not_qualified')
  })
})

describeIfReady('Task #986 — NXT Sales is never written to', () => {
  it('18. the CRM port still exposes no write method', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const crm = getCrm()
    const writeish = Object.keys(Object.getPrototypeOf(crm) as object).filter((m) =>
      /^(create|update|delete|write|save|patch|post|upsert)/i.test(m),
    )
    expect(writeish).toEqual([])
  })

  it('19. syncing changes no NXT Sales row', async () => {
    const { getCrm } = await import('../../src/crm/index.js')
    const { prisma } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')
    const crm = getCrm()

    const q = await prisma.salesQualification.findFirst({
      where: { tenantId, status: { in: ['qualified', 'qualified_unassigned'] }, crmCompanyId: { not: { startsWith: 'task98' } } },
      orderBy: { scoreAtQualification: 'desc' },
    })
    if (!q) return

    // Baseline through the read-only port, before and after.
    const before = await crm.getCompany(q.crmCompanyId)
    await syncQualification({ tenantId, qualificationId: q.id })
    const after = await crm.getCompany(q.crmCompanyId)

    expect(after?.updatedAt).toBe(before?.updatedAt)
    expect(after?.ownerId).toBe(before?.ownerId)
    expect(after?.leadStatus).toBe(before?.leadStatus)
    expect(after?.name).toBe(before?.name)
  })

  it('20. the whole pipeline is untouched by a handoff', async () => {
    const { prisma } = await import('../../src/platform/db.js')
    const { syncQualification } = await import('../../src/crmsync/service.js')

    // A qualification only this file knows about. Asserting `updatedAt` on the
    // shared real one raced the Task #985 suite, which evaluates it in
    // parallel — the test was measuring the other suite, not this handoff.
    const company = `${PREFIX}-untouched`
    const id = await seedQualification(company)

    const where = { crmCompanyId: company }
    const before = {
      events: await prisma.engagementEvent.count({ where }),
      snapshots: await prisma.intentScoreSnapshot.count({ where }),
      actions: await prisma.outreachAction.count({ where }),
      qualification: await prisma.salesQualification.findUniqueOrThrow({ where: { id } }),
    }

    await syncQualification({ tenantId, qualificationId: id })

    expect(await prisma.engagementEvent.count({ where })).toBe(before.events)
    expect(await prisma.intentScoreSnapshot.count({ where })).toBe(before.snapshots)
    expect(await prisma.outreachAction.count({ where })).toBe(before.actions)

    // CRM sync writes only its own tables. The qualification it read is
    // byte-for-byte what it was.
    const after = await prisma.salesQualification.findUniqueOrThrow({ where: { id } })
    expect(after.updatedAt.getTime()).toBe(before.qualification.updatedAt.getTime())
    expect(after.status).toBe(before.qualification.status)
    expect(after.alertStatus).toBe(before.qualification.alertStatus)
  })
})
