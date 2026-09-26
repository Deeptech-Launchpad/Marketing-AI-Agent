import { env } from '../config/env.js'
import { audit } from '../platform/audit.js'
import { prisma, newId } from '../platform/db.js'
import { ConflictError, NotFoundError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { selectCaseStudyPages } from '../websiteaudit/enrichedRecord.js'
import { buildComparison, type ObservationInput } from './improve.js'
import { selectProductPage } from './selection.js'
import { sampleTheme } from './themeExtractor.js'
import { sampleWebsiteShell, type WebsiteShell } from './websiteShell.js'
import { NEUTRAL_THEME, type DemoStatus, type ThemeProfile } from './types.js'

// TASK #981 — building a Workbench from an approved audit.
//
// Runs at BUILD time, not at view time. A prospect opening the link must never
// wait on their own website: everything factual comes from stored Task #979
// rows, and the single live request — sampling the page for colours and fonts —
// happens here, once, with a neutral fallback if it fails.
//
// The approval gate is the other thing this file exists to hold. A Workbench is
// customer-facing, so it may only be built from a report a human approved in
// Task #980. The development bypass is explicit, recorded on the row, and
// refused outright in production by a check at process start.

export interface BuildInput {
  tenantId: string
  auditRunId: string
  requestedByCrmUserId: string
  productPageId?: string | null
}

export interface BuildResult {
  demoId: string
  status: DemoStatus
  statusReason: string | null
  productName: string | null
  productPageUrl: string | null
  observedFieldCount: number
  totalFieldCount: number
  improvedFieldCount: number
  builtFromUnapproved: boolean
  themeSource: string
}

export async function buildWorkbench(input: BuildInput): Promise<BuildResult> {
  const log = logger.child({ auditRunId: input.auditRunId })

  const report = await prisma.auditReport.findFirst({
    where: { auditRunId: input.auditRunId, tenantId: input.tenantId },
  })
  if (!report) throw new NotFoundError('No audit report exists for that run.')

  // ── The approval gate ───────────────────────────────────────────────────
  // Rejection is checked FIRST, before the bypass is even consulted: a
  // reviewer said this report should not be used, and no development flag
  // should be able to talk the system past that.
  if (report.status === 'rejected') {
    throw new ConflictError('This report was rejected by a reviewer and cannot be used for a Workbench.', {
      status: report.status,
    })
  }

  const approved = report.status === 'approved'
  if (!approved) {
    if (!env.WORKBENCH_ALLOW_UNAPPROVED) {
      throw new ConflictError(
        `This report is "${report.status}". A customer-facing Workbench can only be built from a report approved in Task #980.`,
        { status: report.status, hint: 'Approve the report, or set WORKBENCH_ALLOW_UNAPPROVED=true in development only.' },
      )
    }
    log.warn({ status: report.status }, 'building Workbench from an UNAPPROVED report (development bypass)')
  }

  const run = await prisma.websiteAuditRun.findUniqueOrThrow({ where: { id: input.auditRunId } })

  // ── Product selection ───────────────────────────────────────────────────
  // The SAME product the customer report features.
  //
  // Both used to choose independently, so a report could show one product and
  // the Workbench another — for the same company, from the same audit. A
  // customer comparing the two would reasonably conclude one of them was made
  // up. When no page is named explicitly, the report's own selector decides,
  // and the two agree by construction.
  const preferred =
    input.productPageId ?? (await selectCaseStudyPages(input.auditRunId, 1))[0] ?? undefined
  const selection = await selectProductPage(input.auditRunId, preferred)

  if (!selection.page) {
    // No fabricated product, no fake demo. The reason is stored and shown.
    const demo = await upsertDemo({
      tenantId: input.tenantId,
      run,
      report,
      status: 'no_product_page',
      statusReason: selection.reason,
      approved,
    })
    await prisma.workbenchField.deleteMany({ where: { demoId: demo.id } })

    await audit({
      tenantId: input.tenantId,
      actorType: 'user',
      actorCrmUserId: input.requestedByCrmUserId,
      action: 'workbench.built',
      resourceType: 'WorkbenchDemo',
      resourceId: demo.id,
      dataClass: 'internal',
      summary: `${run.companyName}: no product page available — ${selection.reason}`,
    })

    return {
      demoId: demo.id,
      status: 'no_product_page',
      statusReason: selection.reason,
      productName: null,
      productPageUrl: null,
      observedFieldCount: 0,
      totalFieldCount: 0,
      improvedFieldCount: 0,
      builtFromUnapproved: !approved,
      themeSource: 'neutral_default',
    }
  }

  // ── BEFORE, from stored observations only ───────────────────────────────
  const stored = await prisma.pageObservation.findMany({
    where: { pageId: selection.page.pageId },
    select: { id: true, field: true, status: true, value: true, sourcePath: true, fragment: true },
  })
  const observations: ObservationInput[] = stored.map((o) => ({
    id: o.id,
    field: o.field,
    status: o.status,
    value: o.value,
    sourcePath: o.sourcePath,
    fragment: o.fragment,
  }))

  const comparison = buildComparison({ pageUrl: selection.page.url, observations })
  const productName = comparison.fields.find((f) => f.field === 'product.name')?.before ?? null

  // ── The live requests, for presentation only ────────────────────────────
  //
  // Two reads of the same page: its palette, and its furniture. Neither
  // produces a claim about the product; both are what make the demonstration
  // recognisably the customer's own page rather than a card with their data
  // in it. A failure in either is recorded and shown, never papered over.
  const [theme, websiteShell] = await Promise.all([
    sampleTheme(selection.page.url),
    sampleWebsiteShell(selection.page.url),
  ])
  if (theme.source === 'neutral_default') {
    log.info({ reason: theme.reason }, 'theme sampling failed; using the neutral default')
  }
  if (!websiteShell.captured) {
    log.info({ reason: websiteShell.reason }, 'website shell not captured; the Workbench will say so')
  }

  const demo = await upsertDemo({
    tenantId: input.tenantId,
    run,
    report,
    status: 'ready',
    statusReason: null,
    approved,
    page: selection.page,
    productName,
    selectionReason: selection.reason,
    theme,
    websiteShell,
    comparison,
  })

  // Fields are replaced wholesale: a rebuild is a new document, and a stale
  // row from a previous build would be a claim nobody made.
  await prisma.workbenchField.deleteMany({ where: { demoId: demo.id } })
  await prisma.workbenchField.createMany({
    data: comparison.fields.map((f, i) => ({
      id: newId(),
      tenantId: input.tenantId,
      demoId: demo.id,
      field: f.field,
      label: f.label,
      position: i,
      beforeValue: f.before,
      afterValue: f.after,
      delta: f.delta,
      headline: f.headline,
      transformKind: f.provenance.kind,
      sourceObservationId: f.provenance.sourceObservationId,
      sourceField: f.provenance.sourceField,
      sourceUrl: f.provenance.sourceUrl,
      sourcePath: f.provenance.sourcePath,
      sourceFragment: f.provenance.sourceFragment,
      transformRule: f.provenance.rule,
    })),
  })

  await audit({
    tenantId: input.tenantId,
    actorType: 'user',
    actorCrmUserId: input.requestedByCrmUserId,
    action: 'workbench.built',
    resourceType: 'WorkbenchDemo',
    resourceId: demo.id,
    dataClass: 'internal',
    summary:
      `${run.companyName}: ${comparison.observedCount}/${comparison.totalCount} fields observed, ` +
      `${comparison.improvedCount} improved${approved ? '' : ' (UNAPPROVED — development bypass)'}`,
  })

  log.info(
    { demoId: demo.id, observed: comparison.observedCount, improved: comparison.improvedCount, theme: theme.source },
    'workbench built',
  )

  return {
    demoId: demo.id,
    status: 'ready',
    statusReason: null,
    productName,
    productPageUrl: selection.page.url,
    observedFieldCount: comparison.observedCount,
    totalFieldCount: comparison.totalCount,
    improvedFieldCount: comparison.improvedCount,
    builtFromUnapproved: !approved,
    themeSource: theme.source,
  }
}

interface UpsertInput {
  tenantId: string
  run: { id: string; companyName: string | null; startUrl: string | null; crmCompanyId: string }
  report: { id: string; status: string }
  status: DemoStatus
  statusReason: string | null
  approved: boolean
  page?: { pageId: string; url: string }
  productName?: string | null
  selectionReason?: string
  theme?: ThemeProfile
  websiteShell?: WebsiteShell
  comparison?: { structuredData: unknown; valuePoints: unknown; observedCount: number; totalCount: number; improvedCount: number }
}

async function upsertDemo(i: UpsertInput) {
  const data = {
    tenantId: i.tenantId,
    auditReportId: i.report.id,
    crmCompanyId: i.run.crmCompanyId,
    companyName: i.run.companyName,
    websiteUrl: i.run.startUrl,
    productPageId: i.page?.pageId ?? null,
    productPageUrl: i.page?.url ?? null,
    productName: i.productName ?? null,
    selectionReason: i.selectionReason ?? i.statusReason,
    status: i.status,
    statusReason: i.statusReason,
    theme: (i.theme ?? NEUTRAL_THEME) as never,
    websiteShell: (i.websiteShell ?? null) as never,
    structuredData: (i.comparison?.structuredData ?? undefined) as never,
    valuePoints: (i.comparison?.valuePoints ?? undefined) as never,
    observedFieldCount: i.comparison?.observedCount ?? 0,
    totalFieldCount: i.comparison?.totalCount ?? 0,
    improvedFieldCount: i.comparison?.improvedCount ?? 0,
    sourceReportStatus: i.report.status,
    builtFromUnapproved: !i.approved,
    generatedAt: new Date(),
  }

  return prisma.workbenchDemo.upsert({
    where: { auditRunId: i.run.id },
    create: { id: newId(), auditRunId: i.run.id, ...data },
    update: data,
  })
}
