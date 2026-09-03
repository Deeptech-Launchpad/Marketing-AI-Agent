import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// End-to-end run of the full pipeline against the FAKE CRM and FAKE LLM, but a
// REAL database and a REAL queue. Those two have to be real: resumability and
// the audience snapshot are properties of persistence, and a mocked store would
// let the one thing that matters go untested.
//
// Requires MARKETING_DATABASE_URL to point at a migrated database with the
// pgvector extension installed. When that is not available the suite SKIPS with
// a clear reason rather than passing hollowly.
//
// STOP THE WORKER FIRST (`dist/worker.js` / `npm run dev:worker`).
// This suite drives executeNextStep itself so it can assert on each transition.
// A live worker consumes the same run.step queue from the same database, so the
// two race: the worker advances the run underneath the test and steps get
// closed out as abandoned. The symptom is an opaque failure on
// `every(status === 'completed')` rather than anything pointing at the cause.

const DB_URL = process.env.MARKETING_DATABASE_URL ?? ''

async function databaseReady(): Promise<string | null> {
  try {
    const { prisma } = await import('../../src/platform/db.js')
    await prisma.$queryRaw`SELECT 1`
    const rows = await prisma.$queryRaw<Array<{ extname: string }>>`
      SELECT extname FROM pg_extension WHERE extname = 'vector'
    `
    if (!rows.length) return 'pgvector extension is not installed (run sql/001_extensions.sql)'
    await prisma.tenant.count()
    return null
  } catch (err) {
    return `database unavailable: ${(err as Error).message}`
  }
}

const skipReason = await databaseReady()
const describeIfDb = skipReason ? describe.skip : describe

if (skipReason) {
  // eslint-disable-next-line no-console
  console.warn(`\n[e2e] SKIPPED — ${skipReason}\n  DB: ${DB_URL.replace(/:[^:@]*@/, ':****@')}\n`)
}

describeIfDb('end-to-end: "Generate infrastructure leads"', () => {
  let tenantId: string
  let campaignId: string
  let runId: string

  beforeAll(async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const tenant = await prisma.tenant.upsert({
      where: { slug: 'e2e-test' },
      create: { id: newId(), slug: 'e2e-test', name: 'E2E Test' },
      update: {},
    })
    tenantId = tenant.id
  }, 30_000)

  afterAll(async () => {
    const { prisma } = await import('../../src/platform/db.js')
    // Cascades clear runs, steps, tool calls, assets and approvals.
    await prisma.campaign.deleteMany({ where: { tenantId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  it('walks the pipeline, parks at both gates, and ends in an approved package', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { executeNextStep } = await import('../../src/orchestrator/runner.js')
    const { decideApproval } = await import('../../src/approval/approvalService.js')
    const { Prisma } = await import('@prisma/client')

    campaignId = newId()
    await prisma.campaign.create({
      data: {
        id: campaignId,
        tenantId,
        name: 'Generate infrastructure leads',
        objective: 'Generate infrastructure leads',
        createdByCrmUserId: 'operator-1',
      },
    })

    runId = newId()
    await prisma.agentRun.create({
      data: {
        id: runId,
        tenantId,
        campaignId,
        requestedByCrmUserId: 'operator-1',
        objective: 'Generate infrastructure leads',
        mode: 'dry_run',
        status: 'queued',
        budgetTokens: 500_000,
        budgetUsd: new Prisma.Decimal(5),
      },
    })

    // Drive the loop synchronously instead of through the worker, so the test
    // asserts on orchestration rather than on queue timing.
    const drive = async (limit = 20) => {
      for (let i = 0; i < limit; i++) {
        const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
        if (run.status !== 'queued' && run.status !== 'running') return run
        await executeNextStep(runId)
      }
      return prisma.agentRun.findUniqueOrThrow({ where: { id: runId } })
    }

    // ── Gate 1 ────────────────────────────────────────────────────────────
    let run = await drive()
    expect(run.status).toBe('awaiting_approval')
    expect(run.currentStepType).toBe('APPROVAL_STRATEGY')

    const audience = await prisma.agentStep.findFirstOrThrow({
      where: { runId, type: 'SEGMENT_RESOLVE', status: 'completed' },
    })
    const audienceOut = audience.output as Record<string, unknown>
    expect(Number(audienceOut.totalMatched)).toBeGreaterThan(0)
    // Suppression ran, and the snapshot reports its own completeness.
    expect(audienceOut).toHaveProperty('totalSuppressed')
    expect(audienceOut).toHaveProperty('truncated')

    const strategyApproval = await prisma.approval.findFirstOrThrow({
      where: { runId, kind: 'strategy', status: 'pending' },
    })

    // A stale hash must be refused, not silently accepted.
    await expect(
      decideApproval({
        tenantId,
        approvalId: strategyApproval.id,
        decision: 'approved',
        payloadHash: 'f'.repeat(64),
        crmUserId: 'approver-1',
      }),
    ).rejects.toThrow(/payload changed/i)

    // The requester cannot approve their own run.
    await expect(
      decideApproval({
        tenantId,
        approvalId: strategyApproval.id,
        decision: 'approved',
        payloadHash: strategyApproval.payloadHash,
        crmUserId: 'operator-1',
      }),
    ).rejects.toThrow(/self-approval/i)

    await decideApproval({
      tenantId,
      approvalId: strategyApproval.id,
      decision: 'approved',
      payloadHash: strategyApproval.payloadHash,
      crmUserId: 'approver-1',
    })

    // ── Gate 2 ────────────────────────────────────────────────────────────
    run = await drive()
    expect(run.status).toBe('awaiting_approval')
    expect(run.currentStepType).toBe('APPROVAL_CONTENT')

    const assets = await prisma.asset.findMany({ where: { runId }, include: { versions: true } })
    expect(assets.length).toBeGreaterThan(0)
    expect(assets.every((a) => a.versions.length > 0)).toBe(true)

    const contentApproval = await prisma.approval.findFirstOrThrow({
      where: { runId, kind: 'content', status: 'pending' },
    })
    await decideApproval({
      tenantId,
      approvalId: contentApproval.id,
      decision: 'approved',
      payloadHash: contentApproval.payloadHash,
      crmUserId: 'approver-1',
    })

    // ── Terminal ──────────────────────────────────────────────────────────
    run = await drive()
    expect(run.status).toBe('completed')

    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: campaignId } })
    expect(campaign.status).toBe('approved')

    // THE Phase 1 safety property: no write tool was dispatched, because none
    // exists. If this ever fails, the dispatcher is broken, not the assertion.
    const toolCalls = await prisma.toolCall.findMany({ where: { runId } })
    expect(toolCalls.length).toBeGreaterThan(0)
    expect(toolCalls.filter((t) => t.sideEffectClass !== 'read')).toEqual([])
    expect(toolCalls.filter((t) => t.status === 'blocked')).toEqual([])

    // Every step is persisted in order — this is what makes a run resumable.
    const steps = await prisma.agentStep.findMany({ where: { runId }, orderBy: { seq: 'asc' } })
    expect(steps.map((s) => s.type)).toContain('PACKAGE')
    expect(steps.every((s) => s.status === 'completed')).toBe(true)
  }, 120_000)

  it('re-enters generation when a reviewer requests changes', async () => {
    const { prisma, newId } = await import('../../src/platform/db.js')
    const { executeNextStep } = await import('../../src/orchestrator/runner.js')
    const { decideApproval } = await import('../../src/approval/approvalService.js')
    const { Prisma } = await import('@prisma/client')

    const cid = newId()
    await prisma.campaign.create({
      data: { id: cid, tenantId, name: 'Rework', objective: 'Generate infrastructure leads', createdByCrmUserId: 'operator-1' },
    })
    const rid = newId()
    await prisma.agentRun.create({
      data: {
        id: rid,
        tenantId,
        campaignId: cid,
        requestedByCrmUserId: 'operator-1',
        objective: 'Generate infrastructure leads',
        mode: 'dry_run',
        status: 'queued',
        budgetTokens: 500_000,
        budgetUsd: new Prisma.Decimal(5),
      },
    })

    for (let i = 0; i < 20; i++) {
      const r = await prisma.agentRun.findUniqueOrThrow({ where: { id: rid } })
      if (r.status !== 'queued' && r.status !== 'running') break
      await executeNextStep(rid)
    }

    const approval = await prisma.approval.findFirstOrThrow({ where: { runId: rid, kind: 'strategy' } })
    await decideApproval({
      tenantId,
      approvalId: approval.id,
      decision: 'changes_requested',
      payloadHash: approval.payloadHash,
      comment: 'Too broad — narrow to one vertical.',
      crmUserId: 'approver-1',
    })

    const run = await prisma.agentRun.findUniqueOrThrow({ where: { id: rid } })
    expect(run.status).toBe('running')
    expect(run.currentStepType).toBe('STRATEGY')
    // The reviewer's words are carried to the regenerating step, not discarded.
    expect(run.feedback).toContain('narrow to one vertical')

    await executeNextStep(rid)

    // The rejected strategy is preserved; a NEW version is written alongside it.
    const versions = await prisma.campaignStrategy.findMany({ where: { campaignId: cid } })
    expect(versions.length).toBe(2)
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2])
  }, 120_000)
})
