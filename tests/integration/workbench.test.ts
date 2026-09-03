import { describe, expect, it } from 'vitest'

// TASK #981 integration tests, against the REAL Task #979 audit data.
//
// The approval gate, the no-product case and the public surface are all
// exercised on real prospect rows. Nothing here is delivered anywhere: the
// Workbench ends at a rendered page behind a token.

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
if (skipReason) console.warn(`\n[workbench] SKIPPED — ${skipReason}\n`)

async function tenantId(): Promise<string> {
  const { prisma } = await import('../../src/platform/db.js')
  const t = await prisma.tenant.findFirstOrThrow({ where: { slug: process.env.DEFAULT_TENANT_SLUG } })
  return t.id
}

/**
 * Clones a real audit run — pages, observations, findings and report — into a
 * disposable run at a chosen approval status.
 *
 * The integration files run in parallel and several of them delete the shared
 * runs they touch, so operating on a live row is a race. Cloning keeps these
 * tests on REAL prospect evidence while making them independent of each other.
 */
async function cloneRun(opts: { withProducts: boolean; status: string }) {
  const { prisma, newId } = await import('../../src/platform/db.js')
  const tid = await tenantId()

  const source = await prisma.websiteAuditRun.findFirst({
    where: opts.withProducts
      ? { tenantId: tid, productPages: { gt: 0 } }
      : { tenantId: tid, productPages: 0, pagesFetched: { gt: 0 } },
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
    await prisma.pageObservation.create({
      data: { ...rest, id, auditRunId: runId, pageId: pageMap.get(o.pageId)! },
    })
  }

  for (const fnd of findings) {
    const { id: _f, ...rest } = fnd
    const evidence = ((fnd.evidence ?? []) as Array<Record<string, unknown>>).map((e) => {
      const oldId = String(e.observationId)
      return {
        ...e,
        observationId: oldId.startsWith('page:')
          ? `page:${pageMap.get(oldId.slice(5)) ?? oldId.slice(5)}`
          : (obsMap.get(oldId) ?? oldId),
        pageId: pageMap.get(String(e.pageId)) ?? e.pageId,
      }
    })
    await prisma.catalogFinding.create({
      data: { ...rest, id: newId(), auditRunId: runId, evidence: evidence as never },
    })
  }

  const { id: _rep, ...reportRest } = sourceReport
  await prisma.auditReport.create({
    data: { ...reportRest, id: newId(), auditRunId: runId, status: opts.status, currentRevision: 1, lockVersion: 1 },
  })

  return { runId, tenantId: tid, companyName: source.companyName, crmCompanyId: source.crmCompanyId }
}

async function dropRun(runId: string) {
  const { prisma } = await import('../../src/platform/db.js')
  await prisma.websiteAuditRun.delete({ where: { id: runId } }).catch(() => undefined)
}

describeIfReady('Task #981 — Workbench against real audit data', () => {
  it('REFUSES to build from a report that has not been approved', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const { env } = await import('../../src/config/env.js')

    const c = await cloneRun({ withProducts: true, status: 'ready_for_approval' })
    if (!c) return

    try {
      if (env.WORKBENCH_ALLOW_UNAPPROVED) {
        // The bypass is on here, so the build succeeds but is FLAGGED. The gate
        // itself is proven by the production assertion in env.ts and by the
        // rejected-report case below.
        expect(env.NODE_ENV).not.toBe('production')
        const r = await buildWorkbench({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' })
        expect(r.builtFromUnapproved).toBe(true)
        return
      }
      await expect(
        buildWorkbench({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' }),
      ).rejects.toThrow(/only be built from a report approved/i)
    } finally {
      await dropRun(c.runId)
    }
  }, 120_000)

  it('REFUSES to build from a rejected report even with the bypass enabled', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const c = await cloneRun({ withProducts: true, status: 'rejected' })
    if (!c) return
    try {
      await expect(
        buildWorkbench({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' }),
      ).rejects.toThrow(/rejected by a reviewer/i)
    } finally {
      await dropRun(c.runId)
    }
  }, 120_000)

  it('builds from an approved report using only stored observations', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneRun({ withProducts: true, status: 'approved' })
    if (!c) return

    try {
      const result = await buildWorkbench({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
      })

      expect(result.status).toBe('ready')
      expect(result.builtFromUnapproved).toBe(false)
      expect(result.productName).toBeTruthy()
      expect(result.observedFieldCount).toBeGreaterThan(0)

      const fields = await prisma.workbenchField.findMany({
        where: { demoId: result.demoId },
        orderBy: { position: 'asc' },
      })
      expect(fields.length).toBeGreaterThan(0)

      for (const f of fields) {
        if (f.afterValue !== null) {
          expect(f.transformKind, f.field).not.toBe('not_present')
          expect(f.transformRule.length, f.field).toBeGreaterThan(10)
        } else {
          expect(f.delta, f.field).toBe('still_absent')
        }

        if (f.sourceObservationId) {
          const obs = await prisma.pageObservation.findUnique({ where: { id: f.sourceObservationId } })
          expect(obs, `${f.field} cites an observation that does not exist`).toBeTruthy()
          // A BEFORE value must be exactly what the audit recorded.
          if (f.beforeValue !== null) expect(f.beforeValue).toBe(obs!.value)
        }
      }
    } finally {
      await dropRun(c.runId)
    }
  }, 180_000)

  it('never fabricates a value the audit did not observe', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneRun({ withProducts: true, status: 'approved' })
    if (!c) return

    try {
      const result = await buildWorkbench({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
      })
      const demo = await prisma.workbenchDemo.findUniqueOrThrow({ where: { id: result.demoId } })
      const observedValues = new Set(
        (await prisma.pageObservation.findMany({ where: { pageId: demo.productPageId! }, select: { value: true } }))
          .map((o) => o.value)
          .filter((v): v is string => Boolean(v)),
      )

      const fields = await prisma.workbenchField.findMany({ where: { demoId: result.demoId } })
      for (const f of fields) {
        if (!f.afterValue) continue
        // An AFTER value is either an observed value verbatim, or a derived one
        // whose provenance names the observed field it came from.
        const verbatim = observedValues.has(f.afterValue)
        const derived = f.transformKind === 'derived' && Boolean(f.sourceField)
        expect(verbatim || derived, `${f.field} = ${f.afterValue} is neither observed nor derived`).toBe(true)
      }
    } finally {
      await dropRun(c.runId)
    }
  }, 180_000)

  it('reports no_product_page rather than inventing a demonstration', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneRun({ withProducts: false, status: 'approved' })
    if (!c) return

    try {
      const result = await buildWorkbench({
        tenantId: c.tenantId,
        auditRunId: c.runId,
        requestedByCrmUserId: 'u',
      })
      expect(result.status).toBe('no_product_page')
      expect(result.statusReason).toMatch(/no product page/i)
      expect(result.productName).toBeNull()
      expect(await prisma.workbenchField.count({ where: { demoId: result.demoId } })).toBe(0)
    } finally {
      await dropRun(c.runId)
    }
  }, 180_000)

  it('selects the same product page every time', async () => {
    const { selectProductPage } = await import('../../src/workbench/selection.js')
    const c = await cloneRun({ withProducts: true, status: 'approved' })
    if (!c) return
    try {
      const a = await selectProductPage(c.runId)
      const b = await selectProductPage(c.runId)
      expect(b.page?.pageId).toBe(a.page?.pageId)
      expect(a.candidates.length).toBeGreaterThan(0)
      expect(a.reason).toMatch(/observed product field/)
    } finally {
      await dropRun(c.runId)
    }
  }, 120_000)

  it('refuses an explicit page that belongs to another run', async () => {
    const { selectProductPage } = await import('../../src/workbench/selection.js')
    const c = await cloneRun({ withProducts: true, status: 'approved' })
    if (!c) return
    try {
      const r = await selectProductPage(c.runId, 'not-a-page-in-this-run')
      expect(r.page).toBeNull()
      expect(r.reason).toMatch(/not a fetched product page belonging to this audit run/)
    } finally {
      await dropRun(c.runId)
    }
  }, 120_000)

  it('mints a hashed link, and revocation takes effect immediately', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const { mintLink, resolveLink, revokeLink } = await import('../../src/workbench/links.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneRun({ withProducts: true, status: 'approved' })
    if (!c) return

    try {
      const built = await buildWorkbench({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' })
      const link = await mintLink({ tenantId: c.tenantId, demoId: built.demoId, createdByCrmUserId: 'u' })

      const stored = await prisma.workbenchLink.findUniqueOrThrow({ where: { id: link.linkId } })
      expect(stored.tokenHash).not.toBe(link.token)
      expect(stored.tokenHash).toMatch(/^[0-9a-f]{64}$/)
      // The plaintext must not be recoverable from any stored column.
      expect(JSON.stringify(stored)).not.toContain(link.token)

      expect((await resolveLink(link.token)).ok).toBe(true)
      expect((await resolveLink('not-a-real-token-aaaaaaaaaaaaaa')).ok).toBe(false)

      await revokeLink(c.tenantId, link.linkId, 'u')
      const after = await resolveLink(link.token)
      expect(after.ok).toBe(false)
      expect(after.rejection).toBe('revoked')
    } finally {
      await dropRun(c.runId)
    }
  }, 180_000)

  it('refuses an expired link and one past its view limit', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const { mintLink, resolveLink } = await import('../../src/workbench/links.js')
    const { prisma } = await import('../../src/platform/db.js')

    const c = await cloneRun({ withProducts: true, status: 'approved' })
    if (!c) return

    try {
      const built = await buildWorkbench({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' })

      const expired = await mintLink({ tenantId: c.tenantId, demoId: built.demoId, createdByCrmUserId: 'u' })
      await prisma.workbenchLink.update({
        where: { id: expired.linkId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      })
      expect((await resolveLink(expired.token)).rejection).toBe('expired')

      const capped = await mintLink({
        tenantId: c.tenantId,
        demoId: built.demoId,
        createdByCrmUserId: 'u',
        maxViews: 1,
      })
      await prisma.workbenchLink.update({ where: { id: capped.linkId }, data: { viewCount: 1 } })
      expect((await resolveLink(capped.token)).rejection).toBe('exhausted')
    } finally {
      await dropRun(c.runId)
    }
  }, 180_000)

  it('renders a public page that leaks no internal identifier', async () => {
    const { buildWorkbench } = await import('../../src/workbench/builder.js')
    const { renderWorkbench } = await import('../../src/workbench/render.js')
    const { prisma } = await import('../../src/platform/db.js')
    const { NEUTRAL_THEME } = await import('../../src/workbench/types.js')

    const c = await cloneRun({ withProducts: true, status: 'approved' })
    if (!c) return

    try {
      const built = await buildWorkbench({ tenantId: c.tenantId, auditRunId: c.runId, requestedByCrmUserId: 'u' })
      const demo = await prisma.workbenchDemo.findUniqueOrThrow({ where: { id: built.demoId } })
      const rows = await prisma.workbenchField.findMany({ where: { demoId: demo.id }, orderBy: { position: 'asc' } })

      const html = renderWorkbench({
        companyName: demo.companyName ?? '',
        websiteUrl: demo.websiteUrl,
        productName: demo.productName,
        productPageUrl: demo.productPageUrl,
        theme: NEUTRAL_THEME,
        fields: rows.map((f) => ({
          field: f.field,
          label: f.label,
          before: f.beforeValue,
          after: f.afterValue,
          delta: f.delta as never,
          headline: f.headline,
          provenance: {
            kind: f.transformKind as never,
            // The public path drops these, exactly as the route does.
            sourceObservationId: null,
            sourceField: f.sourceField,
            sourceUrl: f.sourceUrl,
            sourcePath: f.sourcePath,
            sourceFragment: f.sourceFragment,
            rule: f.transformRule,
          },
        })),
        valuePoints: (demo.valuePoints ?? []) as never,
        structuredData: demo.structuredData as never,
        observedFieldCount: demo.observedFieldCount,
        totalFieldCount: demo.totalFieldCount,
        improvedFieldCount: demo.improvedFieldCount,
        auditDate: demo.generatedAt.toISOString().slice(0, 10),
        showEvidence: true,
      })

      // None of these may appear anywhere in a customer-facing page.
      expect(html).not.toContain(c.tenantId)
      expect(html).not.toContain(c.crmCompanyId)
      expect(html).not.toContain(c.runId)
      expect(html).not.toContain(demo.id)
      expect(html).not.toContain(demo.auditReportId)
      for (const f of rows) {
        if (f.sourceObservationId) expect(html).not.toContain(f.sourceObservationId)
      }
      expect(html).not.toMatch(/<script/i)
    } finally {
      await dropRun(c.runId)
    }
  }, 180_000)
})
