import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import type { SalesCollateral } from './collateral.js'
import type { CatalogFinding } from './findings.js'

// TASK #979 — the personalised PDF audit report.
//
// Three pages, as specified: summary and verified metrics, then findings with
// examples from real inspected pages, then impact, recommendations and the next
// step.
//
// The constraint that shapes it: every important claim must be traceable. So
// the PDF prints the source URL and the literal source fragment next to each
// finding, and closes with an evidence appendix listing the observation
// references behind it. A reader who doubts a line can open the page and check
// it — which is the only reason a prospect should believe a document like this.
//
// Nothing here composes new prose. Every sentence was already written and
// claim-guarded upstream, and this file lays it out.

export interface PdfResult {
  bytes: Buffer
  sha256: string
  pageCount: number
}

const PAGE = { size: 'A4' as const, margin: 50 }
const INK = { heading: '#111827', body: '#374151', muted: '#6b7280', rule: '#d1d5db', accent: '#1d4ed8' }

/** Priority is printed as a word, never as a colour-only cue. */
const PRIORITY_LABEL: Record<string, string> = { high: 'HIGH', medium: 'MEDIUM', low: 'LOW' }

interface Ctx {
  doc: PDFKit.PDFDocument
  pageCount: () => number
}

/**
 * An image registered once and drawn many times.
 *
 * pdfkit implements `openImage`, but @types/pdfkit does not declare it, so the
 * shape is declared here rather than reaching for `any`. Only the identity
 * matters — the value is handed straight back to `doc.image()`.
 */
type OpenedImage = { width: number; height: number }
type DocWithOpenImage = PDFKit.PDFDocument & { openImage(src: Buffer): OpenedImage }

export interface RenderOptions {
  /** Absolute or project-relative path to the brand logo. */
  logoPath?: string
  /** A Workbench URL to render as a QR code on the closing page. */
  workbenchUrl?: string | null
}

export async function renderAuditPdf(
  collateral: SalesCollateral,
  findings: CatalogFinding[],
  options: RenderOptions = {},
): Promise<PdfResult> {
  // The document is dated to the AUDIT, not to the moment the bytes were
  // produced. That is both more accurate and what makes the output
  // reproducible: regenerating a report from the same stored observations
  // yields byte-identical output, so a copy on disk can be checked against the
  // one a prospect was sent. Left as "now", every regeneration would differ.
  const created = new Date(`${collateral.auditDate}T00:00:00Z`)
  const creationDate = Number.isNaN(created.getTime()) ? new Date(0) : created

  const doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true,
    info: {
      Title: `Product Data Health Check — ${collateral.companyName}`,
      Author: 'AltiusNXT',
      Subject: `Website product-data audit of ${collateral.website}`,
      Creator: 'AltiusNXT Marketing Agent',
      Producer: 'AltiusNXT Marketing Agent',
      CreationDate: creationDate,
      ModDate: creationDate,
    },
  })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))

  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()))

  const ctx: Ctx = { doc, pageCount: () => doc.bufferedPageRange().count }

  if (collateral.audience === 'customer') {
    // The courier document. A different sequence, not a trimmed one — see
    // renderCustomerReport for what it deliberately never prints.
    await renderCustomerReport(ctx, collateral, options)
  } else {
    renderPageOne(ctx, collateral)
    doc.addPage()
    renderPageTwo(ctx, collateral, findings)
    doc.addPage()
    renderPageThree(ctx, collateral, findings)
  }

  // Read BEFORE end(): pdfkit flushes its buffered page range on end, and
  // reading afterwards reports zero.
  const pageCount = ctx.pageCount()

  doc.end()
  await done

  const bytes = Buffer.concat(chunks)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), pageCount }
}

// ── Layout helpers ─────────────────────────────────────────────────────────

function h1(doc: PDFKit.PDFDocument, text: string): void {
  doc.fillColor(INK.heading).font('Helvetica-Bold').fontSize(22).text(text, { lineGap: 2 })
  doc.moveDown(0.4)
}

function h2(doc: PDFKit.PDFDocument, text: string): void {
  doc.moveDown(0.6)
  doc.fillColor(INK.heading).font('Helvetica-Bold').fontSize(13).text(text)
  doc.moveDown(0.25)
}

function body(doc: PDFKit.PDFDocument, text: string, opts: { size?: number; color?: string } = {}): void {
  doc
    .fillColor(opts.color ?? INK.body)
    .font('Helvetica')
    .fontSize(opts.size ?? 10)
    .text(text, { align: 'left', lineGap: 1.5 })
}

function rule(doc: PDFKit.PDFDocument): void {
  doc.moveDown(0.5)
  const y = doc.y
  doc.strokeColor(INK.rule).lineWidth(0.7).moveTo(doc.page.margins.left, y).lineTo(doc.page.width - doc.page.margins.right, y).stroke()
  doc.moveDown(0.6)
}

/** Evidence is printed in a mono face so a fragment reads as a quotation. */
function evidenceLine(doc: PDFKit.PDFDocument, label: string, value: string): void {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(INK.muted).text(`${label} `, { continued: true })
  doc.font('Courier').fontSize(8).fillColor(INK.body).text(truncate(value, 150))
}

function truncate(s: string, n: number): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean
}

// ═══════════════════════════════════════════════════════════════════════════
// THE CUSTOMER / COURIER REPORT
// ═══════════════════════════════════════════════════════════════════════════
//
// A different document from the internal audit, not a shortened one.
//
// What it NEVER prints, and why each is deliberate:
//   · the evidence appendix        — that is the methodology
//   · source fragments             — markup quotes are an engineering artifact
//   · per-finding recommendations  — the approach is the sales conversation
//   · every affected page          — the count is credibility, the list is the
//                                    deliverable somebody would otherwise not
//                                    need to buy
//   · internal identifiers         — a run id means nothing to a customer and
//                                    is a detail about our systems
//
// The withholding is enforced upstream in buildCollateral, which returns a
// customer object with those fields already empty. This renderer prints what
// it is given, so a future change to the layout cannot reintroduce a leak.

async function renderCustomerReport(
  ctx: Ctx,
  c: SalesCollateral,
  options: RenderOptions,
): Promise<void> {
  const { doc } = ctx
  const logoBytes = loadLogo(options.logoPath)
  // Opened once and reused. Calling doc.image() with the same buffer on each
  // page makes pdfkit register a separate XObject per call, which both repeats
  // the logo six times in the file and makes the object numbering vary between
  // runs — so the same audit produced different bytes each time. openImage
  // registers it once; every page then references the one object.
  const logo = logoBytes ? (doc as DocWithOpenImage).openImage(logoBytes) : null

  // ── PAGE 1 — the health check ────────────────────────────────────────
  customerHeader(doc, c, logo, true)
  h1(doc, 'Product Data Health Check')
  doc.fillColor(INK.muted).font('Helvetica').fontSize(10.5).text(
    `${c.companyName}    ·    ${c.website}    ·    Audit date ${c.auditDate}`,
  )
  rule(doc)

  h2(doc, 'What we observed')
  body(doc, c.businessValue.whatWeObserved, { size: 10.5 })

  if (c.keyFindings.length) {
    h2(doc, 'Strongest observations')
    c.keyFindings.forEach((f) => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK.accent).text(PRIORITY_LABEL[f.priority] ?? f.priority.toUpperCase())
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK.heading).text(f.title)
      doc.font('Helvetica').fontSize(9.5).fillColor(INK.body).text(f.metric, { lineGap: 1.5 })
      doc.moveDown(0.45)
    })
  } else {
    h2(doc, 'Strongest observations')
    body(doc, 'No product-data finding was recorded against the inspected pages.')
  }

  h2(doc, 'Audit scope')
  doc.font('Helvetica').fontSize(9).fillColor(INK.body).text(
    `${c.pagesInspected} page(s) inspected · ${c.productPagesInspected} product page(s) · ${c.categoryPagesInspected} category page(s)`,
  )
  doc.moveDown(0.3)
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK.muted).text(c.scopeNote)

  // ── PAGE 2 — where the opportunity may be ────────────────────────────
  if (c.businessPain.length) {
    doc.addPage()
    customerHeader(doc, c, logo, false)
    h1(doc, 'Where the opportunity may be')
    rule(doc)

    c.businessPain.forEach((p, i) => {
      if (doc.y > doc.page.height - 190 && i > 0) {
        doc.addPage()
        customerHeader(doc, c, logo, false)
        h1(doc, 'Where the opportunity may be (continued)')
        rule(doc)
      }
      labelled(doc, 'OBSERVED', p.observation)
      labelled(doc, 'BUSINESS PAIN', p.businessPain)
      labelled(doc, 'WHY IT MATTERS', p.whyItMatters)
      labelled(doc, 'POTENTIAL OPPORTUNITY', p.potentialOpportunity)
      doc.moveDown(0.55)
    })

    if (c.withheldNote) {
      doc.moveDown(0.2)
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(INK.muted).text(c.withheldNote)
    }
  }

  // ── PAGE 3 — before / after ──────────────────────────────────────────
  if (c.examples.length) {
    doc.addPage()
    customerHeader(doc, c, logo, false)
    h1(doc, 'The same product, better described')
    doc.fillColor(INK.muted).font('Helvetica').fontSize(9).text(
      'Taken from a product page on this site. Every improved value comes from something already published on the page — nothing is invented.',
    )
    rule(doc)

    c.examples.forEach((ex) => {
      doc.font('Helvetica-Bold').fontSize(11).fillColor(INK.heading).text(ex.productName ?? 'Product page')
      if (ex.productUrl) doc.font('Helvetica').fontSize(8).fillColor(INK.muted).text(truncate(ex.productUrl, 100))
      doc.moveDown(0.5)

      ex.fields.forEach((f) => {
        if (doc.y > doc.page.height - 150) {
          doc.addPage()
          customerHeader(doc, c, logo, false)
          h1(doc, 'The same product, better described (continued)')
          rule(doc)
        }
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK.heading).text(f.label)
        doc.moveDown(0.15)
        beforeAfterRow(doc, 'BEFORE', f.before ?? 'not present on the page', f.before ? INK.body : INK.muted)
        beforeAfterRow(doc, 'AFTER', f.after ?? 'not present on the page', f.after ? INK.body : INK.muted)
        // The rule, not the mechanism. It says WHY this value is legitimate
        // without describing how enrichment works.
        provenanceLine(doc, f.provenance.rule)
        doc.moveDown(0.5)
      })
    })
  }

  // ── PAGE 4 — how AltiusNXT can help ──────────────────────────────────
  doc.addPage()
  customerHeader(doc, c, logo, false)
  h1(doc, 'How AltiusNXT can help')
  rule(doc)
  body(doc, c.businessValue.howAltiusNxtCanHelp, { size: 10.5 })
  doc.moveDown(0.6)
  h2(doc, 'What the improved experience could look like')
  body(doc, c.businessValue.improvedExperience, { size: 10.5 })
  doc.moveDown(0.8)
  doc.font('Helvetica-Oblique').fontSize(9).fillColor(INK.muted).text(
    'This summary describes the direction rather than the detail. The full approach — how each field is sourced, ' +
      'structured and kept current — is what the walkthrough covers.',
  )

  // ── PAGE 5 — discoverability, only where evidence exists ─────────────
  const hasComparison = c.comparison.available
  if (c.discoverability.length || hasComparison) {
    doc.addPage()
    customerHeader(doc, c, logo, false)
    h1(doc, 'Discoverability considerations')
    rule(doc)

    if (c.discoverability.length) {
      doc.fillColor(INK.muted).font('Helvetica').fontSize(9).text(
        'Observations about factors that may affect how products are found and interpreted. These describe the inspected pages; no ranking or visibility position was measured.',
      )
      doc.moveDown(0.6)
      c.discoverability.forEach((d) => {
        doc.font('Helvetica-Bold').fontSize(8).fillColor(INK.accent).text(d.lens.toUpperCase())
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK.heading).text(d.observation)
        doc.font('Helvetica').fontSize(9.5).fillColor(INK.body).text(d.consideration, { lineGap: 1.5 })
        doc.moveDown(0.5)
      })
    }

    if (c.comparison.available) {
      h2(doc, `Compared with ${c.comparison.peerLabel}`)
      body(doc, c.comparison.summary, { size: 9.5 })
      doc.moveDown(0.3)
      c.comparison.rows.forEach((r) => {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(INK.heading).text(r.attribute)
        doc.font('Helvetica').fontSize(8.5).fillColor(INK.body).text(`This site: ${r.prospect}`, { indent: 10 })
        doc.font('Helvetica').fontSize(8.5).fillColor(INK.body).text(`Comparable: ${r.peer}`, { indent: 10 })
        doc.moveDown(0.3)
      })
      doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK.muted).text(c.comparison.methodNote)
    }
  }

  // ── PAGE 6 — the next step ───────────────────────────────────────────
  doc.addPage()
  customerHeader(doc, c, logo, false)
  h1(doc, 'Next step')
  rule(doc)
  body(doc, c.businessValue.nextStep, { size: 11 })
  doc.moveDown(0.8)

  doc.font('Helvetica-Bold').fontSize(14).fillColor(INK.accent).text(c.cta.label.toUpperCase())
  if (c.cta.url) {
    doc.moveDown(0.3)
    doc.font('Helvetica').fontSize(9.5).fillColor(INK.body).text(c.cta.url, { link: c.cta.url, underline: false })
  } else {
    doc.moveDown(0.3)
    doc.font('Helvetica-Oblique').fontSize(9).fillColor(INK.muted).text(
      'A booking link has not been configured for this report. Your AltiusNXT contact will arrange a time.',
    )
  }

  const qr = options.workbenchUrl ? await qrPng(options.workbenchUrl) : null
  if (qr) {
    doc.moveDown(1)
    const y = doc.y
    doc.image(qr, doc.page.margins.left, y, { width: 108 })
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK.heading).text('See it on your own product', doc.page.margins.left + 124, y + 10)
    doc.font('Helvetica').fontSize(9).fillColor(INK.body).text(
      'Scan to open the interactive before-and-after built from this audit.',
      doc.page.margins.left + 124,
      doc.y + 2,
      { width: doc.page.width - doc.page.margins.left - doc.page.margins.right - 124 },
    )
    doc.y = y + 120
    doc.x = doc.page.margins.left
  }

  doc.moveDown(1.4)
  rule(doc)
  // The two disclaimers the business requires on a customer artifact: what was
  // inspected, and that nothing financial was measured.
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK.muted).text(c.scopeNote)
  doc.moveDown(0.4)
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK.muted).text(c.businessValue.financialNote)
  // The legal wording is configuration, never a literal here. Team Answer F.6
  // reserves it for legal and compliance, and generateCustomerReport refuses
  // to produce a customer report without it — so the fallback below is only
  // ever reached through the development bypass, and says exactly that rather
  // than printing something that could be mistaken for approved copy.
  doc.moveDown(0.4)
  doc
    .font('Helvetica-Oblique')
    .fontSize(8)
    .fillColor(INK.muted)
    .text(c.legalDisclaimer ?? '[No legal disclaimer configured — this document is not approved for sending.]')
}

// ── Customer layout helpers ────────────────────────────────────────────────

/** A labelled block: the label is the structure, so it is set as one. */
function labelled(doc: PDFKit.PDFDocument, label: string, text: string): void {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK.muted).text(label)
  doc.font('Helvetica').fontSize(10).fillColor(INK.body).text(text, { lineGap: 1.5 })
  doc.moveDown(0.35)
}

/**
 * A two-column row: a small label, then the value.
 *
 * Positioned with explicit x and width rather than `indent`, because pdfkit's
 * indent applies to the FIRST line only — a wrapped value fell back to the
 * page margin and broke out of its column.
 */
const VALUE_INDENT = 62

function beforeAfterRow(doc: PDFKit.PDFDocument, label: string, value: string, colour: string): void {
  const left = doc.page.margins.left + 10
  const valueX = doc.page.margins.left + VALUE_INDENT
  const valueW = doc.page.width - doc.page.margins.right - valueX
  const y = doc.y

  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK.muted).text(label, left, y + 2, { width: valueX - left })
  // Written second so the cursor ends below the taller of the two columns.
  doc
    .font(colour === INK.muted ? 'Helvetica-Oblique' : 'Helvetica')
    .fontSize(9.5)
    .fillColor(colour)
    .text(truncate(value, 200), valueX, y, { width: valueW, lineGap: 1 })
  doc.x = doc.page.margins.left
}

/** The rule under a before/after pair, aligned to the value column. */
function provenanceLine(doc: PDFKit.PDFDocument, rule: string): void {
  const x = doc.page.margins.left + VALUE_INDENT
  doc
    .font('Helvetica-Oblique')
    .fontSize(7.5)
    .fillColor(INK.muted)
    .text(rule, x, doc.y + 1, { width: doc.page.width - doc.page.margins.right - x, lineGap: 0.5 })
  doc.x = doc.page.margins.left
}

/** The brand mark, mandatory on every customer artifact (Team Answer F.6). */
function loadLogo(path?: string): Buffer | null {
  const candidates = [path, 'web/public/altiusnxt-logo.png', 'assets/altiusnxt-logo.png'].filter(
    (p): p is string => Boolean(p),
  )
  for (const p of candidates) {
    try {
      return readFileSync(p)
    } catch {
      // Try the next candidate. A missing logo is reported by the caller's
      // validation rather than thrown here, so a report still renders.
    }
  }
  return null
}

function customerHeader(
  doc: PDFKit.PDFDocument,
  c: SalesCollateral,
  logo: OpenedImage | null,
  first: boolean,
): void {
  const top = doc.page.margins.top
  if (logo) {
    // Cast for the same typings gap as openImage: pdfkit accepts a registered
    // image object here, the declaration only admits a path or a buffer.
    doc.image(logo as unknown as PDFKit.Mixins.ImageSrc, doc.page.margins.left, top - 12, { height: 22 })
  } else {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(INK.heading).text('AltiusNXT', doc.page.margins.left, top - 8)
  }
  if (!first) {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(INK.muted)
      .text(`${c.companyName} · ${c.auditDate}`, doc.page.margins.left, top - 6, {
        align: 'right',
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      })
  }
  doc.x = doc.page.margins.left
  doc.y = top + 26
}

/** Renders a QR as a PNG buffer. Returns null rather than failing a report. */
async function qrPng(url: string): Promise<Buffer | null> {
  try {
    return await QRCode.toBuffer(url, { type: 'png', margin: 1, width: 320, errorCorrectionLevel: 'M' })
  } catch {
    return null
  }
}

// ── Page 1: summary and verified metrics ───────────────────────────────────

function renderPageOne(ctx: Ctx, c: SalesCollateral): void {
  const { doc } = ctx

  doc.fillColor(INK.accent).font('Helvetica-Bold').fontSize(9).text('PRODUCT DATA HEALTH CHECK')
  doc.moveDown(0.3)
  h1(doc, c.companyName)

  doc.fillColor(INK.muted).font('Helvetica').fontSize(10).text(`${c.website}    ·    Audit date ${c.auditDate}`)
  rule(doc)

  h2(doc, 'Audit summary')
  body(doc, c.summary)

  h2(doc, 'Verified metrics')
  doc.moveDown(0.2)

  // Each metric prints its basis underneath. A number without its basis is the
  // thing this whole task is built to avoid.
  c.metrics.slice(0, 8).forEach((m) => {
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK.heading).text(`${m.value}  `, { continued: true })
    doc.font('Helvetica').fontSize(10).fillColor(INK.body).text(m.label)
    doc.font('Helvetica').fontSize(8).fillColor(INK.muted).text(m.basis, { indent: 10 })
    doc.moveDown(0.35)
  })

  rule(doc)
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK.muted).text(c.scopeNote)
}

// ── Page 2: findings, with examples from inspected pages ───────────────────

function renderPageTwo(ctx: Ctx, c: SalesCollateral, findings: CatalogFinding[]): void {
  const { doc } = ctx

  h1(doc, 'Key findings')
  doc.fillColor(INK.muted).font('Helvetica').fontSize(9).text(
    'Each finding below was derived from pages inspected on this site. The source URL and the literal fragment behind it are printed with the finding.',
  )
  rule(doc)

  if (!findings.length) {
    body(doc, 'No product-data finding was recorded against the inspected pages.')
    return
  }

  findings.slice(0, 4).forEach((f, i) => {
    if (doc.y > doc.page.height - 200 && i > 0) {
      doc.addPage()
      h1(doc, 'Key findings (continued)')
      rule(doc)
    }

    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK.accent).text(PRIORITY_LABEL[f.priority] ?? f.priority.toUpperCase())
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK.heading).text(f.title)
    doc.moveDown(0.2)

    body(doc, f.finding)
    doc.moveDown(0.2)
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK.body).text(f.metric)
    doc.moveDown(0.3)

    // Examples from real inspected product pages.
    const shown = f.evidence.slice(0, 2)
    shown.forEach((e) => {
      evidenceLine(doc, 'page  ', e.sourceUrl)
      evidenceLine(doc, 'field ', `${e.field} = ${e.status}${e.value ? ` (${truncate(e.value, 60)})` : ''}`)
      if (e.sourcePath) evidenceLine(doc, 'where ', e.sourcePath)
      if (e.fragment) evidenceLine(doc, 'source', e.fragment)
      doc.moveDown(0.25)
    })

    if (f.evidence.length > shown.length) {
      doc
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(INK.muted)
        .text(`${f.evidence.length - shown.length} further evidence record(s) are stored with this finding.`)
    }

    doc.moveDown(0.5)
  })
}

// ── Page 3: impact, recommendations, next step, evidence appendix ──────────

function renderPageThree(ctx: Ctx, c: SalesCollateral, findings: CatalogFinding[]): void {
  const { doc } = ctx

  h1(doc, 'Impact and recommendations')
  rule(doc)

  h2(doc, 'What this means in practice')
  if (c.businessImpact.length) {
    c.businessImpact.forEach((t) => {
      doc.font('Helvetica').fontSize(10).fillColor(INK.body).text(`•  ${t}`, { lineGap: 1.5 })
      doc.moveDown(0.3)
    })
  } else {
    body(doc, 'No impact statement applies, because no finding was recorded.')
  }

  h2(doc, 'Recommended improvement areas')
  if (c.recommendedImprovementAreas.length) {
    c.recommendedImprovementAreas.forEach((t, i) => {
      doc.font('Helvetica').fontSize(10).fillColor(INK.body).text(`${i + 1}.  ${t}`, { lineGap: 1.5 })
      doc.moveDown(0.3)
    })
  } else {
    body(doc, 'No recommendation applies, because no finding was recorded.')
  }

  h2(doc, 'Next step')
  body(doc, c.nextStep)

  rule(doc)

  // The appendix is what makes the document checkable rather than merely
  // confident: every finding, and the exact pages it came from.
  h2(doc, 'Evidence appendix')
  doc.font('Helvetica').fontSize(8).fillColor(INK.muted).text(
    'Every finding in this report is stored with the observation records behind it. The pages cited below were inspected on the date shown on page 1.',
  )
  doc.moveDown(0.4)

  findings.forEach((f) => {
    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK.heading).text(`${f.code}  (${f.priority})`)
    const urls = [...new Set(f.evidence.map((e) => e.sourceUrl))].slice(0, 3)
    urls.forEach((u) => doc.font('Courier').fontSize(7).fillColor(INK.body).text(truncate(u, 110), { indent: 8 }))
    doc.moveDown(0.25)
  })

  doc.moveDown(0.5)
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(INK.muted).text(c.scopeNote)
}
