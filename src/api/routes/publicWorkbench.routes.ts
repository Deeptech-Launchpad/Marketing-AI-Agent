import { brandedEnrichedPdpHtml } from '../../workbench/enrichedPdpBrand.js'
import type { PdpEnrichment } from '../../websiteaudit/pdpEnrichment.js'
import { Router, type Request, type Response } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { env } from '../../config/env.js'
import { audit } from '../../platform/audit.js'
import { prisma, newId } from '../../platform/db.js'
import { fetchAsset } from '../../research/pageFetch.js'
import {
  captureWorkbenchEvent,
  isQrEntry,
  type WorkbenchContext,
} from '../../engagement/adapters/workbenchAdapter.js'
import {
  hashIp,
  hashSession,
  newSessionToken,
  newVisitToken,
  readCookie,
  recordView,
  resolveLink,
  sessionCookieValue,
  SESSION_COOKIE,
  visitCookieValue,
  VISIT_COOKIE,
} from '../../workbench/links.js'
import {
  PUBLIC_CSP,
  renderEvidencePage,
  renderLinkUnavailable,
  renderNoProduct,
  renderRegistration,
  renderWorkbench,
} from '../../workbench/render.js'
import { NEUTRAL_THEME, type ComparedField, type ThemeProfile, type ValuePoint } from '../../workbench/types.js'
import { asyncHandler } from '../middleware/errorHandler.js'

// TASK #981 — the PUBLIC Workbench.
//
// This is the only unauthenticated surface in the platform, so it is written
// defensively:
//
//   * A token resolves to exactly one demo. There is no other query shape, no
//     id parameter, and no way to enumerate.
//   * Nothing internal is emitted. No tenant id, no CRM id, no audit run id,
//     no observation id, no database key of any kind reaches the response.
//   * The page carries no JavaScript and a CSP with no script-src, so an
//     injected script is inert as well as escaped.
//   * A prospect logo is proxied through here, so the prospect's server never
//     sees a customer's IP and never serves anything into our origin unchecked.
//
// KNOWN AND ACCEPTED: the link is a bearer credential. Anyone holding the URL
// can open the demonstration until it expires or is revoked. That is the
// trade-off of a QR code on a printed report.

export const publicWorkbenchRoutes = Router()

/** Stricter than the internal API: this is reachable by anyone. */
const publicLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.WORKBENCH_PUBLIC_RATE_LIMIT,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Every rejection looks the same as an invalid link, so the limiter cannot be
  // used to distinguish real tokens from guesses.
  handler: (_req, res) => sendHtml(res, 429, renderLinkUnavailable('Too many requests. Please try again shortly.')),
})

// Scoped to /workbench, NOT to the whole router.
//
// This router is mounted at the application root so its public URLs stay short,
// which means every request in the process passes through it — including the
// authenticated /api/v1 surface mounted after it. A path-less `use()` here
// therefore applied this 60-per-minute ANONYMOUS VISITOR budget to the entire
// internal API, and the operator interface started failing with 429 as soon as
// it made more than sixty calls in a minute.
//
// The path argument confines the limit to the surface it was written for.
publicWorkbenchRoutes.use('/workbench', publicLimiter)

// Form posts arrive as urlencoded; JSON is not accepted on this router.
publicWorkbenchRoutes.use('/workbench', (req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')

  // TASK #983: an anonymous visit id, minted before anything else so that the
  // page views of one browser are recognisable as one visit. It grants no
  // access — see the note in workbench/links.ts — and is set here rather than
  // per-route so that the very first request already has one.
  if (!readCookie(req.headers.cookie, VISIT_COOKIE)) {
    const visit = newVisitToken()
    res.append('Set-Cookie', visitCookieValue(visit.token))
    // Make it visible to this request too, so the event recorded on this very
    // page view carries the same reference as the ones that follow it.
    req.headers.cookie = `${req.headers.cookie ? `${req.headers.cookie}; ` : ''}${VISIT_COOKIE}=${encodeURIComponent(
      visit.token,
    )}`
  }
  next()
})

function sendHtml(res: Response, status: number, html: string): void {
  res.status(status)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Content-Security-Policy', PUBLIC_CSP)
  res.setHeader('Cache-Control', 'no-store, private')
  res.send(html)
}

const RegistrationSchema = z.object({
  fullName: z.string().trim().min(2).max(120),
  companyName: z.string().trim().min(1).max(160),
  workEmail: z.string().trim().email().max(200),
  jobTitle: z.string().trim().max(120).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
})

interface LoadedDemo {
  demo: NonNullable<Awaited<ReturnType<typeof prisma.workbenchDemo.findUnique>>>
  linkId: string
  fields: ComparedField[]
  theme: ThemeProfile
  valuePoints: ValuePoint[]
  /**
   * TASK #983: the company, resolved from the demo the TOKEN points at.
   *
   * This is the only place a public request's company is ever determined. No
   * handler below reads an id from the query, the body or a header, so a caller
   * cannot write engagement history into an account they were not given a link
   * for.
   */
  context: WorkbenchContext
}

/** Resolves a token to its demo, or renders the refusal and returns null. */
async function load(req: Request, res: Response): Promise<LoadedDemo | null> {
  const token = String(req.params.token ?? '')
  const resolved = await resolveLink(token)
  if (!resolved.ok || !resolved.link) {
    sendHtml(res, 404, renderLinkUnavailable(resolved.reason ?? 'This link is not valid.'))
    return null
  }

  const demo = await prisma.workbenchDemo.findUnique({ where: { id: resolved.link.demoId } })
  if (!demo) {
    sendHtml(res, 404, renderLinkUnavailable('This link is not valid.'))
    return null
  }

  const rows = await prisma.workbenchField.findMany({
    where: { demoId: demo.id },
    orderBy: { position: 'asc' },
  })

  const fields: ComparedField[] = rows.map((f) => ({
    field: f.field,
    label: f.label,
    before: f.beforeValue,
    after: f.afterValue,
    delta: f.delta as ComparedField['delta'],
    headline: f.headline,
    provenance: {
      kind: f.transformKind as ComparedField['provenance']['kind'],
      // Internal identifiers are deliberately dropped on the public path.
      sourceObservationId: null,
      sourceField: f.sourceField,
      sourceUrl: f.sourceUrl,
      sourcePath: f.sourcePath,
      sourceFragment: f.sourceFragment,
      rule: f.transformRule,
    },
  }))

  return {
    demo,
    linkId: resolved.link.id,
    fields,
    theme: (demo.theme as unknown as ThemeProfile) ?? NEUTRAL_THEME,
    valuePoints: ((demo.valuePoints ?? []) as unknown as ValuePoint[]) ?? [],
    context: {
      tenantId: demo.tenantId,
      crmCompanyId: demo.crmCompanyId,
      demoId: demo.id,
      auditRunId: demo.auditRunId,
      linkId: resolved.link.id,
      companyName: demo.companyName,
    },
  }
}

async function currentVisitor(req: Request, demoId: string) {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE)
  if (!token) return null
  const visitor = await prisma.workbenchVisitor.findUnique({ where: { sessionHash: hashSession(token) } })
  // A session is only valid for the demo it was created against.
  return visitor && visitor.demoId === demoId ? visitor : null
}

function logoPath(demo: { id: string; theme: unknown }, token: string): string | null {
  const theme = demo.theme as ThemeProfile | null
  return theme?.logoUrl ? `/workbench/${token}/logo` : null
}

/** The customer entry point: registration, then the Workbench. */
publicWorkbenchRoutes.get(
  '/workbench/:token',
  asyncHandler(async (req: Request, res: Response) => {
    const loaded = await load(req, res)
    if (!loaded) return

    const { demo, fields, theme, valuePoints, linkId, context } = loaded
    const token = String(req.params.token)
    const visitor = await currentVisitor(req, demo.id)

    // The link was opened. This is the one act we can always observe.
    await captureWorkbenchEvent({
      eventType: 'workbench_link_opened',
      context,
      req,
      what: `The Workbench link for ${demo.companyName ?? 'this company'} was opened.`,
      where: `/workbench/${token.slice(0, 4)}…`,
      how: 'The server rendered the page in response to a request for the link.',
    })

    // A QR scan is recorded ONLY when the request carries the marker the
    // printed code encodes. Without it the server knows a URL was opened and
    // nothing more, so it says nothing more.
    if (isQrEntry(req)) {
      await captureWorkbenchEvent({
        eventType: 'audit_report_qr_scanned',
        context,
        req,
        what: `The QR code on ${demo.companyName ?? 'this company'}'s audit report was scanned.`,
        where: `/workbench/${token.slice(0, 4)}…?s=qr`,
        how: 'The request carried the s=qr marker that only the printed QR code encodes. A pasted URL carrying the same marker would be indistinguishable.',
        referenceKind: 'workbench_link',
        referenceId: linkId,
      })
    }

    if (!visitor) {
      await captureWorkbenchEvent({
        eventType: 'workbench_registration_started',
        context,
        req,
        what: 'The registration form was shown to a visitor who was not yet registered.',
        where: `/workbench/${token.slice(0, 4)}…`,
        how: 'The server rendered the registration form because the request carried no valid session.',
      })
      sendHtml(
        res,
        200,
        renderRegistration({
          companyName: demo.companyName ?? 'your company',
          theme,
          token,
          productName: demo.productName,
          logoPath: logoPath(demo, token),
        }),
      )
      return
    }

    await recordView(linkId)
    await prisma.workbenchVisitor.update({
      where: { id: visitor.id },
      data: { lastSeenAt: new Date(), viewCount: { increment: 1 } },
    })

    if (demo.status === 'no_product_page') {
      sendHtml(
        res,
        200,
        renderNoProduct({
          companyName: demo.companyName ?? 'your company',
          theme,
          reason: demo.statusReason ?? 'The audit did not record a product page for this website.',
          logoPath: logoPath(demo, token),
        }),
      )
      return
    }

    // The Workbench itself was seen. Once per visit, however many refreshes.
    await captureWorkbenchEvent({
      eventType: 'workbench_viewed',
      context,
      req,
      what: `A registered visitor viewed the before/after comparison for ${demo.productName ?? 'a product page'}.`,
      where: `/workbench/${token.slice(0, 4)}…`,
      how: 'The server rendered the comparison for a request carrying a valid session.',
    })

    // Panel focus. `both` is the arrival view, so it is not a focus act; asking
    // for one side specifically is.
    const panel = panelFrom(req)
    if (panel !== 'both') {
      await captureWorkbenchEvent({
        eventType: panel === 'before' ? 'workbench_before_viewed' : 'workbench_after_viewed',
        context,
        req,
        what:
          panel === 'before'
            ? 'The visitor asked to see their current product page on its own.'
            : 'The visitor asked to see the improved version on its own.',
        where: `/workbench/${token.slice(0, 4)}…?panel=${panel}`,
        how: 'The visitor followed a link that loads a single panel. There is no JavaScript on this page, so this is a real navigation the server served.',
      })

      // Switching panels IS the comparison behaviour, so each switch counts.
      await captureWorkbenchEvent({
        eventType: 'workbench_comparison_used',
        context,
        req,
        what: `The visitor switched the comparison to the "${panel}" view.`,
        where: `/workbench/${token.slice(0, 4)}…?panel=${panel}`,
        how: 'Observed as a navigation between comparison views.',
        metadata: { panel },
        // Switching to "before" and switching to "after" are different acts,
        // even seconds apart. Without this the repeat-window would merge them
        // and the second switch would disappear from the record.
        dedupeDiscriminator: panel,
      })
    }

    // THE END PDP AUDIT: the enriched product page is the demonstration. The
    // same HTML the Workbench After view and the report's "Enriched Result"
    // page show. "?panel=before" still serves the original comparison.
    const pdpRun = await prisma.websiteAuditRun.findUnique({
      where: { id: demo.auditRunId },
      select: { pdpEnrichment: true },
    })
    const enrichment = pdpRun?.pdpEnrichment as unknown as PdpEnrichment | null
    const branded = enrichment?.status === 'ready' && panel !== 'before' ? await brandedEnrichedPdpHtml(demo.auditRunId) : null
    if (branded) {
      res.status(200)
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      // Product images and the logo are served from the customer's own website.
      res.setHeader('Content-Security-Policy', PUBLIC_CSP.replace("img-src 'self' data:", "img-src 'self' data: https:"))
      res.setHeader('Cache-Control', 'no-store, private')
      res.send(branded)
      return
    }

    sendHtml(
      res,
      200,
      renderWorkbench({
        companyName: demo.companyName ?? 'your company',
        websiteUrl: demo.websiteUrl,
        productName: demo.productName,
        productPageUrl: demo.productPageUrl,
        theme,
        fields,
        valuePoints,
        structuredData: (demo.structuredData as Record<string, unknown> | null) ?? null,
        observedFieldCount: demo.observedFieldCount,
        totalFieldCount: demo.totalFieldCount,
        improvedFieldCount: demo.improvedFieldCount,
        auditDate: demo.generatedAt.toISOString().slice(0, 10),
        visitorName: visitor.fullName,
        logoPath: logoPath(demo, token),
        showEvidence: true,
        token,
        panel,
      }),
    )
  }),
)

/** Reads the panel the visitor asked for. Anything unrecognised is the default. */
function panelFrom(req: Request): 'before' | 'after' | 'both' {
  const value = String(req.query.panel ?? '')
  return value === 'before' || value === 'after' ? value : 'both'
}

/** Registration. A plain form POST — the flow works without any JavaScript. */
publicWorkbenchRoutes.post(
  '/workbench/:token/register',
  asyncHandler(async (req: Request, res: Response) => {
    const loaded = await load(req, res)
    if (!loaded) return

    const { demo, theme, linkId } = loaded
    const token = String(req.params.token)
    const parsed = RegistrationSchema.safeParse(req.body ?? {})

    if (!parsed.success) {
      sendHtml(
        res,
        400,
        renderRegistration({
          companyName: demo.companyName ?? 'your company',
          theme,
          token,
          productName: demo.productName,
          logoPath: logoPath(demo, token),
          error: 'Please check the highlighted details — a name, a company and a valid work email are needed.',
          values: (req.body ?? {}) as Record<string, string>,
        }),
      )
      return
    }

    const v = parsed.data
    const session = newSessionToken()
    const visitorId = newId()

    await prisma.workbenchVisitor.create({
      data: {
        id: visitorId,
        tenantId: demo.tenantId,
        demoId: demo.id,
        linkId,
        fullName: v.fullName,
        companyName: v.companyName,
        workEmail: v.workEmail.toLowerCase(),
        jobTitle: v.jobTitle || null,
        phone: v.phone || null,
        sessionHash: session.hash,
        userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) || null,
        ipHash: hashIp(req.ip),
      },
    })

    // Recorded for the internal audit trail. Deliberately NOT written to
    // NXT Sales, not scored, not routed — those are later tasks.
    await audit({
      tenantId: demo.tenantId,
      actorType: 'system',
      action: 'workbench.visitor_registered',
      resourceType: 'WorkbenchVisitor',
      resourceId: demo.id,
      dataClass: 'customer_pii',
      summary: `A visitor registered to view the ${demo.companyName} Workbench`,
    })

    // TASK #983: registration is an act the prospect performed, and the
    // reference is the visitor row it produced — so two people registering
    // through the same link are two events, not one.
    await captureWorkbenchEvent({
      eventType: 'workbench_registration_completed',
      context: loaded.context,
      req,
      what: 'A visitor completed the registration form to open the Workbench.',
      where: `/workbench/${token.slice(0, 4)}…/register`,
      how: 'The server accepted a form submission and created a visitor record.',
      referenceKind: 'workbench_visitor',
      referenceId: visitorId,
      // Deliberately no name, email, company or title. The visitor row holds
      // those already; copying them here would spread PII for no gain.
      metadata: { hasJobTitle: Boolean(v.jobTitle), hasPhone: Boolean(v.phone) },
    })

    // `append`, not `set`: the visit cookie may already be queued on this
    // response, and overwriting it would lose the visit correlation.
    res.append('Set-Cookie', sessionCookieValue(session.token))
    // Redirect so a refresh does not resubmit the form.
    res.redirect(303, `/workbench/${encodeURIComponent(token)}`)
  }),
)

/**
 * The call-to-action, routed through our own server.
 *
 * This exists so that a click is an OBSERVED act rather than an assumed one.
 * The page has no JavaScript, so without this hop the visitor would leave for
 * the booking page and we would never know. The redirect target is the
 * configured CTA URL and nothing else — no destination is accepted from the
 * request, so this cannot be used as an open redirect.
 */
publicWorkbenchRoutes.get(
  '/workbench/:token/cta',
  asyncHandler(async (req: Request, res: Response) => {
    const loaded = await load(req, res)
    if (!loaded) return

    const token = String(req.params.token)
    await captureWorkbenchEvent({
      eventType: 'workbench_cta_clicked',
      context: loaded.context,
      req,
      what: `The visitor clicked "${env.WORKBENCH_CTA_LABEL}".`,
      where: `/workbench/${token.slice(0, 4)}…/cta`,
      how: 'The click was served as a redirect through this server before the visitor reached the booking page.',
    })

    // 302, not 301: a permanent redirect would be cached by the browser and
    // every later click would skip the server entirely.
    res.redirect(302, env.WORKBENCH_CTA_URL)
  }),
)

/**
 * The source evidence, as a page of its own.
 *
 * Task #981 rendered this as an inline `<details>` disclosure. A browser
 * expanding a `<details>` element is invisible to the server, so "the visitor
 * checked where our claims came from" could not be observed. This is the same
 * table reached by a navigation, which can be.
 */
publicWorkbenchRoutes.get(
  '/workbench/:token/evidence',
  asyncHandler(async (req: Request, res: Response) => {
    const loaded = await load(req, res)
    if (!loaded) return

    const { demo, fields, theme, valuePoints, context } = loaded
    const token = String(req.params.token)

    // Same gate as the comparison itself: evidence is not a way around
    // registration.
    const visitor = await currentVisitor(req, demo.id)
    if (!visitor) {
      res.redirect(303, `/workbench/${encodeURIComponent(token)}`)
      return
    }

    await captureWorkbenchEvent({
      eventType: 'workbench_evidence_viewed',
      context,
      req,
      what: 'The visitor opened the page showing where each value came from.',
      where: `/workbench/${token.slice(0, 4)}…/evidence`,
      how: 'The server rendered the evidence page in response to a navigation.',
    })

    sendHtml(
      res,
      200,
      renderEvidencePage({
        companyName: demo.companyName ?? 'your company',
        websiteUrl: demo.websiteUrl,
        productName: demo.productName,
        productPageUrl: demo.productPageUrl,
        theme,
        fields,
        valuePoints,
        structuredData: (demo.structuredData as Record<string, unknown> | null) ?? null,
        observedFieldCount: demo.observedFieldCount,
        totalFieldCount: demo.totalFieldCount,
        improvedFieldCount: demo.improvedFieldCount,
        auditDate: demo.generatedAt.toISOString().slice(0, 10),
        logoPath: logoPath(demo, token),
        showEvidence: true,
        token,
      }),
    )
  }),
)

/**
 * Proxies the prospect logo.
 *
 * Goes through the shared SSRF-guarded transport and serves only image content
 * types. The alternative — hotlinking — would leak every viewer's IP to the
 * prospect's server and let them serve anything they liked into our page.
 */
publicWorkbenchRoutes.get(
  '/workbench/:token/logo',
  asyncHandler(async (req: Request, res: Response) => {
    const resolved = await resolveLink(String(req.params.token ?? ''))
    if (!resolved.ok || !resolved.link) {
      res.status(404).end()
      return
    }
    const demo = await prisma.workbenchDemo.findUnique({
      where: { id: resolved.link.demoId },
      select: { theme: true },
    })
    const url = (demo?.theme as ThemeProfile | null)?.logoUrl
    if (!url) {
      res.status(404).end()
      return
    }

    // One guarded request: the type check and the download are the same fetch,
    // so a redirect cannot point the download somewhere the check never saw.
    // SVG is excluded deliberately — it is a script-bearing document format.
    const asset = await fetchAsset(url, {
      allowedTypes: /^image\/(png|jpeg|jpg|gif|webp|avif)$/,
      maxBytes: 512 * 1024,
    })
    if (!asset.ok || !asset.bytes) {
      res.status(404).end()
      return
    }

    res.setHeader('Content-Type', asset.contentType ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.send(asset.bytes)
  }),
)
