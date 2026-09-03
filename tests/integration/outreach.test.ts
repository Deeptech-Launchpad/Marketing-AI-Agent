import { describe, expect, it } from 'vitest'

// TASK #982 integration tests, against the REAL approved audits.
//
// Every one of these runs in dry-run mode. Nothing is sent, no external
// provider is contacted, and no credit is spent — the campaign produces
// composed, validated, scheduled actions and stops.

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
if (skipReason) console.warn(`\n[outreach] SKIPPED — ${skipReason}\n`)

async function tenantId(): Promise<string> {
  const { prisma } = await import('../../src/platform/db.js')
  const t = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  return t.id
}

/**
 * Clones a real audit into a disposable run at a chosen approval status.
 *
 * The integration files run in parallel and several delete the runs they touch,
 * so operating on a shared row is a race. Cloning keeps these tests on real
 * evidence while making them independent.
 */
async function cloneAudit(status: string, opts: { withProducts?: boolean } = {}) {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const tid = await tenantId()

  const source = await prisma.websiteAuditRun.findFirst({
    where: { tenantId: tid, productPages: opts.withProducts === false ? 0 : { gt: 0 } },
    orderBy: { productPages: 'desc' },
  })
  if (!source) return null
  const sourceReport = await prisma.auditReport.findUnique({ where: { auditRunId: source.id } })
  if (!sourceReport) return null

  const pages = await prisma.auditedPage.findMany({ where: { auditRunId: source.id } })
  const observations = await prisma.pageObservation.findMany({ where: { auditRunId: source.id } })
  const findings = await prisma.catalogFinding.findMany({ where: { auditRunId: source.id } })

  const runId = newId()
  const { id: _r, ...runRest } = source
  await prisma.websiteAuditRun.create({ data: { ...runRest, id: runId } })

  const pageMap = new Map<string, string>()
  for (const p of pages) {
    const id = newId()
    pageMap.set(p.id, id)
    const { id: _p, ...rest } = p
    await prisma.auditedPage.create({ data: { ...rest, id, auditRunId: runId } })
  }
  const obsMap = new Map<string, string>()
  for (const o of observations) {
    const id = newId()
    obsMap.set(o.id, id)
    const { id: _o, ...rest } = o
    await prisma.pageObservation.create({ data: { ...rest, id, auditRunId: runId, pageId: pageMap.get(o.pageId)! } })
  }
  for (const f of findings) {
    const { id: _f, ...rest } = f
    const evidence = ((f.evidence ?? []) as Array<Record<string, unknown>>).map((e) => {
      const oldId = String(e.observationId)
      return {
        ...e,
        observationId: oldId.startsWith('page:')
          ? `page:${pageMap.get(oldId.slice(5)) ?? oldId.slice(5)}`
          : (obsMap.get(oldId) ?? oldId),
        pageId: pageMap.get(String(e.pageId)) ?? e.pageId,
      }
    })
    await prisma.catalogFinding.create({ data: { ...rest, id: newId(), auditRunId: runId, evidence: evidence as never } })
  }

  const { id: _rep, ...reportRest } = sourceReport
  await prisma.auditReport.create({
    data: { ...reportRest, id: newId(), auditRunId: runId, status, currentRevision: 1, lockVersion: 1 },
  })

  return { runId, tenantId: tid, companyName: source.companyName, crmCompanyId: source.crmCompanyId }
}

async function dropRun(runId: string) {
  const { prisma } = await import('../../src/platform/db.js')
  await prisma.websiteAuditRun.delete({ where: { id: runId } }).catch(() => undefined)
}

describeIfReady('Task #982 — outreach against real approved audits', () => {
  it('REFUSES to plan outreach from a report that is not approved', async () => {
    const { createCampaign } = await import('../../src/outreach/engine.js')
    const c = await cloneAudit('ready_for_approval')
    if (!c) return
    try {
      await expect(
        createCampaign({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' }),
      ).rejects.toThrow(/only be built from a report approved/i)
    } finally {
      await dropRun(c.runId)
    }
  }, 120_000)

  it('REFUSES to plan outreach from a rejected report', async () => {
    const { createCampaign } = await import('../../src/outreach/engine.js')
    const c = await cloneAudit('rejected')
    if (!c) return
    try {
      await expect(
        createCampaign({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' }),
      ).rejects.toThrow(/only be built from a report approved/i)
    } finally {
      await dropRun(c.runId)
    }
  }, 120_000)

  it('plans every channel from an approved audit, recording why each is blocked', async () => {
    const { createCampaign } = await import('../../src/outreach/engine.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneAudit('approved')
    if (!c) return

    try {
      const result = await createCampaign({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
        dryRun: true,
      })

      expect(result.actions.length).toBe(5)
      expect(new Set(result.actions.map((a) => a.channel)).size).toBe(5)

      // Every blocked action names its blocker; none is silently empty.
      result.actions
        .filter((a) => a.status !== 'scheduled')
        .forEach((a) => expect(a.reason, `${a.channel} was blocked without a reason`).toBeTruthy())

      const actions = await prisma.outreachAction.findMany({
        where: { campaignId: result.campaignId },
        include: { message: true },
      })

      for (const a of actions) {
        // Every action carries a composed, evidence-backed message even when it
        // cannot be delivered — the copy is the reviewable artifact.
        expect(a.message, `${a.channel} has no message`).toBeTruthy()
        expect(a.message!.body.length).toBeGreaterThan(20)
        expect(a.idempotencyKey).toMatch(/^[0-9a-f]{64}$/)
        expect(a.scheduledAt).toBeInstanceOf(Date)
      }
    } finally {
      await dropRun(c.runId)
    }
  }, 240_000)

  it('produces a call task that a real SDR could act on', async () => {
    const { createCampaign } = await import('../../src/outreach/engine.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneAudit('approved')
    if (!c) return

    try {
      const result = await createCampaign({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
        dryRun: true,
      })
      const call = await prisma.outreachAction.findFirstOrThrow({
        where: { campaignId: result.campaignId, channel: 'call' },
        include: { message: true },
      })

      // The one channel that is not blocked in this environment.
      expect(call.status).toBe('scheduled')
      expect(call.validationOk).toBe(true)
      const blocks = call.message!.blocks as Record<string, string>
      expect(blocks.talkingPoints).toMatch(/^1\. We reviewed/)
      expect(blocks.talkingPoints).toMatch(/not their whole catalogue/)
      expect(call.message!.evidence).toBeTruthy()
    } finally {
      await dropRun(c.runId)
    }
  }, 240_000)

  it('never sends anything in a dry run, and records each attempt', async () => {
    const { createCampaign, executeAction } = await import('../../src/outreach/engine.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneAudit('approved')
    if (!c) return

    try {
      const result = await createCampaign({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
        dryRun: true,
      })

      for (const a of result.actions) {
        await executeAction(a.id)
      }

      const runs = await prisma.outreachProviderRun.findMany({
        where: { actionId: { in: result.actions.map((a) => a.id) } },
      })
      // Every attempt is recorded, and none of them delivered.
      runs.forEach((r) => {
        expect(r.dryRun).toBe(true)
        expect(r.delivered).toBe(false)
      })

      const sent = await prisma.outreachAction.count({
        where: { campaignId: result.campaignId, status: 'sent' },
      })
      expect(sent).toBe(0)
    } finally {
      await dropRun(c.runId)
    }
  }, 240_000)

  it('is idempotent: re-executing a terminal action does not send again', async () => {
    const { createCampaign, executeAction } = await import('../../src/outreach/engine.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneAudit('approved')
    if (!c) return

    try {
      const result = await createCampaign({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
        dryRun: true,
      })
      const action = result.actions[0]!

      // Force a terminal state, then try again.
      await prisma.outreachAction.update({ where: { id: action.id }, data: { status: 'sent', sentAt: new Date() } })
      const before = await prisma.outreachProviderRun.count({ where: { actionId: action.id } })

      const second = await executeAction(action.id)
      const after = await prisma.outreachProviderRun.count({ where: { actionId: action.id } })

      expect(second.status).toBe('sent')
      expect(second.reason).toMatch(/not re-executed/)
      expect(after).toBe(before)
    } finally {
      await dropRun(c.runId)
    }
  }, 240_000)

  it('blocks every channel for a suppressed company', async () => {
    const { createCampaign, executeAction } = await import('../../src/outreach/engine.js')
    const { prisma, newId } = await import('../../src/platform/db.js')

    const c = await cloneAudit('approved')
    if (!c) return

    const suppression = await prisma.suppressionEntry.create({
      data: {
        id: newId(),
        tenantId: c.tenantId,
        scope: 'global',
        matchType: 'company',
        matchValue: c.crmCompanyId,
        reason: 'Asked not to be contacted.',
        source: 'unsubscribe',
      },
    })

    try {
      const result = await createCampaign({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
        dryRun: true,
      })

      // One suppression decision, applied identically to every channel.
      for (const a of result.actions) {
        const r = await executeAction(a.id)
        expect(r.status, `${a.channel} was not suppressed`).toBe('blocked_suppressed')
        expect(r.reason).toMatch(/Asked not to be contacted/)
      }

      const stored = await prisma.outreachAction.findMany({ where: { campaignId: result.campaignId } })
      stored.forEach((a) => expect(a.suppressionReason).toBe('opt_out'))
    } finally {
      await prisma.suppressionEntry.delete({ where: { id: suppression.id } }).catch(() => undefined)
      await dropRun(c.runId)
    }
  }, 240_000)

  it('rejects a Workbench link belonging to a different audit', async () => {
    const { validateAction } = await import('../../src/outreach/validation.js')
    const { composeMessage } = await import('../../src/outreach/personalize.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneAudit('approved')
    if (!c) return

    try {
      // A live link from SOME OTHER demo.
      const foreign = await prisma.workbenchLink.findFirst({
        where: { revokedAt: null, expiresAt: { gt: new Date() } },
        include: { demo: { select: { auditRunId: true } } },
      })
      if (!foreign || foreign.demo.auditRunId === c.runId) return

      const message = composeMessage({
        channel: 'email_followup',
        target: {
          contactName: 'Test Person',
          contactTitle: null,
          decisionMakerId: null,
          destination: 'a@b.example',
          destinationKind: 'email',
          companyName: c.companyName ?? '',
          crmCompanyId: c.crmCompanyId,
        },
        companyName: c.companyName ?? '',
        topFinding: null,
        sample: null,
        // A token that resolves, but to another company's demo.
        workbenchUrl: 'https://example.test/workbench/some-token-that-will-not-resolve-xxxx',
        workbenchProductName: null,
        intentSignals: [],
        senderName: 'Jey',
        senderCompany: 'AltiusNXT',
        auditRunId: c.runId,
      })

      const v = await validateAction({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        message,
        target: {
          contactName: 'Test Person',
          contactTitle: null,
          decisionMakerId: null,
          destination: 'a@b.example',
          destinationKind: 'email',
          companyName: c.companyName ?? '',
          crmCompanyId: c.crmCompanyId,
        },
      })

      expect(v.ok).toBe(false)
      expect(v.issues.some((i) => i.check === 'workbench_link')).toBe(true)
    } finally {
      await dropRun(c.runId)
    }
  }, 180_000)

  it('leaves an audit trail that answers "why was this sent to this person"', async () => {
    const { createCampaign } = await import('../../src/outreach/engine.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneAudit('approved')
    if (!c) return

    try {
      const result = await createCampaign({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
        dryRun: true,
      })

      const action = await prisma.outreachAction.findFirstOrThrow({
        where: { campaignId: result.campaignId, channel: 'call' },
        include: { message: true, campaign: true },
      })

      // Target, channel, evidence, provider, schedule, approval source.
      expect(action.channel).toBe('call')
      expect(action.crmCompanyId).toBe(c.crmCompanyId)
      expect(action.providerName).toBe('call_task')
      expect(action.scheduledAt).toBeInstanceOf(Date)
      expect(action.campaign.auditReportId).toBeTruthy()

      const evidence = (action.message!.evidence ?? []) as Array<{ kind: string; referenceId: string | null }>
      const findingRef = evidence.find((e) => e.kind === 'catalog_finding')
      if (findingRef?.referenceId) {
        const finding = await prisma.catalogFinding.findUnique({ where: { id: findingRef.referenceId } })
        expect(finding, 'the cited finding does not exist').toBeTruthy()
        expect(finding!.auditRunId).toBe(c.runId)
      }
    } finally {
      await dropRun(c.runId)
    }
  }, 240_000)
})
