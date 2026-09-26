import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import type { EnrichedRecord } from './enrichedRecord.js'
import type { RemediationFix, Scorecard } from './discoverabilityScore.js'
import type { ProductEvidence } from './productEvidence.js'
import {
  asSrc,
  atLeft,
  beforeAfterHeads,
  chip,
  clip,
  BOTTOM,
  Doc,
  DocWithOpenImage,
  footers,
  header,
  INK,
  noteBox,
  OpenedImage,
  PAGE,
  pageTitle,
  pathOf,
  plain,
  sectionHeading,
  statTiles,
  statusInk,
  statusWord,
  table,
  W,
} from './pdpTemplate.js'

// THE AI DISCOVERABILITY AUDIT — the customer-facing document.
//
// Seven pages, laid out after the approved sample report:
//
//   1  AI Discoverability Audit — score, pillars, SKU boundary
//   2  What the engines returned — and, here, what was not tested
//   3  The 15-point scorecard
//   4  What good looks like — this customer's product, before and after
//   5  Visual comparison matrix — their PDP as it is and as it could be
//   6  Strategic remediation roadmap — from the checks that actually failed
//   7  Methodology and sign-off
//
// WHAT THIS FILE MAY AND MAY NOT DO. It lays out values it is given. It
// composes no claim and fills no gap. Two things follow from that and are
// worth stating because the sample report contains both:
//
//   · Page 2 in the sample is a set of live query logs from five answer
//     engines. This platform has no answer-engine harness, so page 2 states
//     what was not tested, in the same visual language, and invents no log.
//   · The sample's benchmark columns (sector average, top decile) are
//     proprietary figures held nowhere in this system. They are absent rather
//     than estimated.
//
// A number on a customer's desk that nobody can trace is worth less than an
// admission that it was not measured.

/**
 * Only the parts of the captured shell this document draws.
 *
 * Structural, not a re-declaration: it is satisfied by the customer view's
 * WebsiteShell, so there is one capture and this names the subset it needs.
 */
export interface ReportWebsiteShell {
  captured: boolean
  siteName: string | null
  logoUrl: string | null
  nav: Array<{ label: string }>
  footerText: string | null
}

export interface PdpReportResult {
  bytes: Buffer
  sha256: string
  pageCount: number
}

export interface PdpReportInput {
  companyName: string
  website: string
  /** "Prepared for <name>" on the footer. */
  preparedFor: string
  /** ISO date the audit completed. Drives the reference and the cover date. */
  auditDate: string
  /** Sector as the CRM or the run's own pages state it. Null when unstated. */
  sector: string | null
  /** Location as the CRM states it. Null when unstated. */
  location: string | null
  pagesInspected: number
  productPagesInspected: number
  /** The scorecard, already computed from observations. */
  scorecard: Scorecard
  /** The fixes, already derived from the failed checks. */
  remediation: RemediationFix[]
  /** The product this report works through. Null when the run found none. */
  subject: EnrichedRecord | null
  /**
   * Which of the four evidence states the run reached, when `subject` is null.
   *
   * A null subject used to print one sentence — "No product page carried
   * enough published data" — for four different situations: a site never read,
   * a site naming nothing it sells, a site naming products but publishing no
   * product page, and a run that got nowhere. The first two are opposites.
   * This is what the report needs to tell them apart, and it is the SAME
   * object the Workbench renders, so the document and the screen cannot drift.
   *
   * Optional so a caller that has not got one still renders.
   */
  productEvidence?: ProductEvidence | null
  /** The category this product's own pages named. */
  categoryLabel: string | null
  /** Attribute set the category calls for, for the AFTER column. */
  recommendedAttributes: Array<{ label: string; state: string; value: string | null; why: string }>
  /** Approved scope wording from upstream. Rendered verbatim. */
  scopeNote: string
  /** Approved next-step wording. Rendered verbatim. */
  nextStep: string
  /** Approved call to action. Rendered verbatim. */
  ctaLabel: string
  /** Who generated and who approved, from the real approval record. */
  preparedBy: { name: string; role: string; email: string | null }
  approvedBy: { name: string; role: string } | null
  /** The customer's Workbench link, as a QR code. Null on a review copy. */
  workbenchUrl: string | null
  legalDisclaimer: string | null
  /** Stamped on every page when this copy is not cleared for a customer. */
  reviewWatermark?: string | null
  logoPath?: string
  /** Fetched product images, keyed by URL. */
  images?: Map<string, Buffer>
  /**
   * THE SAME CAPTURED WEBSITE CONTEXT THE WORKBENCH DRAWS.
   *
   * Passed in from the customer view rather than sampled here, so the page in
   * the PDF and the page on the screen are the same page. Null when the run
   * captured none — the frames then carry the product without the furniture,
   * which is the honest outcome and never a substitute one.
   */
  websiteShell?: ReportWebsiteShell | null
  /**
   * The proposal for this product, as the Workbench shows it. Null when the
   * page published too little to compose from, and nothing is written in its
   * place.
   */
  proposedContent?: { overview: string; bullets: string[] } | null
  /**
   * Illustrative examples for what the hero page does NOT publish, from the
   * customer view — the same set the Workbench's AFTER view shows. Drawn in
   * the improved frame only, always labelled EXAMPLE, never in the frame that
   * shows the customer's page as it is today.
   */
  illustrativeExamples?: Record<string, { value: string; kind: 'sample' | 'format' }> | null
}

/** Illustrative examples are violet everywhere they appear, on screen and on paper. */
const EXAMPLE_INK = '#5b3cc4'

const FOOTER = 'AltiusNxt Technologies Pvt Ltd · AI Discoverability Audit Report'
const TAGLINE = 'Anyone can fill your fields. We make your catalog the answer.'
const PROMISE = 'BE FOUND. BE TRUSTED. BE RECOMMENDED.'

/**
 * The report's own reference, derived from the audit rather than random.
 *
 * Two renders of the same audit produce the same reference, so a reference
 * quoted back to us identifies exactly one audit of one company.
 */
export function referenceFor(input: { companyName: string; auditDate: string; website: string }): string {
  const year = input.auditDate.slice(0, 4)
  const serial = createHash('sha256')
    .update(`${input.companyName}|${input.website}|${input.auditDate}`)
    .digest('hex')
    .slice(0, 4)
    .toUpperCase()
  return `ANXT-AEO-${year}-${serial}`
}

function loadLogo(path?: string): Buffer | null {
  if (!path) return null
  try {
    return readFileSync(path)
  } catch {
    return null
  }
}

const ABSENT = 'Not published on current website'

const fieldValue = (rec: EnrichedRecord, field: string): string | null => {
  const raw = rec.fields.find((f) => f.field === field)?.before
  if (!raw) return null
  const t = plain(raw)
  return t || null
}

export async function renderPdpReport(input: PdpReportInput): Promise<PdpReportResult> {
  const created = new Date(`${input.auditDate}T00:00:00Z`)
  const creationDate = Number.isNaN(created.getTime()) ? new Date(0) : created
  const reference = referenceFor(input)

  const doc: Doc = new PDFDocument({
    size: PAGE.size,
    margin: PAGE.margin,
    bufferPages: true,
    info: {
      Title: `AI Discoverability Audit — ${input.companyName}`,
      Author: 'AltiusNxt Technologies Pvt Ltd',
      Subject: `AI discoverability audit for ${input.companyName}`,
      CreationDate: creationDate,
      ModDate: creationDate,
    },
  })

  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()))

  const logoBytes = loadLogo(input.logoPath)
  const logo = logoBytes ? (doc as DocWithOpenImage).openImage(logoBytes) : null
  const opened = new Map<string, OpenedImage>()
  for (const [url, bytes] of input.images ?? new Map<string, Buffer>()) {
    try {
      opened.set(url, (doc as DocWithOpenImage).openImage(bytes))
    } catch {
      // Not a decodable image: treated as no image at all.
    }
  }

  const subject = input.subject
  // Only consulted where there is no subject: with a real product page the
  // report works through that page and the state adds nothing.
  const evidence = input.productEvidence ?? null
  const humanDate = creationDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 1 — the audit and its score
  // ═══════════════════════════════════════════════════════════════════════
  header(doc, { logo, section: null, reference, date: humanDate, cover: true })

  // The brand band.
  {
    const top = doc.y
    const h = 30
    doc.rect(PAGE.margin, top, W, h).fill(INK.navy)
    doc
      .font('Helvetica-Bold')
      .fontSize(7.6)
      .fillColor('#8fb3ff')
      .text('ALTIUSNXT TECHNOLOGIES PVT LTD', PAGE.margin + 12, top + 7, { characterSpacing: 0.6, lineBreak: false })
    doc
      .font('Helvetica-Oblique')
      .fontSize(7.6)
      .fillColor(INK.white)
      .text(`“${TAGLINE}”`, PAGE.margin + 12, top + 18, { width: W * 0.55, lineBreak: false })
    const pw = 168
    doc.roundedRect(PAGE.margin + W - pw - 10, top + 9, pw, 13, 2).fill(INK.red)
    doc
      .font('Helvetica-Bold')
      .fontSize(6.6)
      .fillColor(INK.white)
      .text(PROMISE, PAGE.margin + W - pw - 10, top + 12.5, { width: pw, align: 'center', characterSpacing: 0.3, lineBreak: false })
    doc.y = top + h + 14
    atLeft(doc)
  }

  pageTitle(doc, 'AI Discoverability Audit', 'Comprehensive Diagnostic: Can AI Find, Understand, and Recommend This Product?')

  // Score panel.
  {
    const top = doc.y
    const h = 78
    const scoreW = 96
    doc.rect(PAGE.margin, top, W, h).fill(INK.panel)
    doc
      .font('Helvetica-Bold')
      .fontSize(34)
      .fillColor(INK.red)
      .text(String(input.scorecard.overall), PAGE.margin, top + 10, { width: scoreW, align: 'center', lineBreak: false })
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(INK.muted)
      .text('/ 100', PAGE.margin, top + 46, { width: scoreW, align: 'center', lineBreak: false })
    doc
      .font('Helvetica-Bold')
      .fontSize(6.4)
      .fillColor(INK.muted)
      .text('OVERALL INDEX', PAGE.margin, top + 60, { width: scoreW, align: 'center', characterSpacing: 0.5, lineBreak: false })

    const x = PAGE.margin + scoreW + 8
    const innerW = W - scoreW - 20
    doc.font('Helvetica-Bold').fontSize(6.8)
    const vw = doc.widthOfString(input.scorecard.verdict) + 12
    doc.roundedRect(x, top + 9, vw, 11, 2).fill(INK.panelRed)
    doc.fillColor(INK.red).text(input.scorecard.verdict, x + 6, top + 11.8, { lineBreak: false })

    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor(INK.navy)
      .text(
        input.sector ? `${input.companyName} — ${input.sector}` : input.companyName,
        x,
        top + 24,
        { width: innerW },
      )
    doc
      .font('Helvetica')
      .fontSize(7.4)
      .fillColor(INK.muted)
      .text(
        [input.location, `Catalog Domain: ${pathOf(input.website) || input.website}`].filter(Boolean).join(' · '),
        x,
        top + 38,
        { width: innerW },
      )
    doc.font('Helvetica-Bold').fontSize(7.6).fillColor(INK.ink).text('Executive Finding: ', x, top + 50, { continued: true })
    doc
      .font('Helvetica')
      .fillColor(INK.body)
      .text(executiveFinding(input), { width: innerW })
    doc.y = top + h + 12
    atLeft(doc)
  }

  // Three pillar cards.
  {
    const gap = 7
    const cardW = (W - gap * 2) / 3
    const h = 66
    const top = doc.y
    const accents = [INK.blue, INK.green, INK.red]
    input.scorecard.pillars.forEach((p, i) => {
      const x = PAGE.margin + i * (cardW + gap)
      doc.rect(x, top, cardW, h).fill(INK.white)
      doc.rect(x, top, cardW, h).lineWidth(0.6).strokeColor(INK.rule).stroke()
      doc.rect(x, top, cardW, 2).fill(accents[i]!)
      doc.font('Helvetica-Bold').fontSize(8).fillColor(INK.navy).text(`${i + 1}. ${p.title}`, x + 8, top + 9, {
        width: cardW - 42,
      })
      doc
        .font('Helvetica-Bold')
        .fontSize(6.4)
        .fillColor(INK.muted)
        .text(`${p.subtitle} (Weight: ${p.weightPct}%)`, x + 8, top + 21, { width: cardW - 42 })
      doc
        .font('Helvetica-Bold')
        .fontSize(15)
        .fillColor(accents[i]!)
        .text(String(p.score), x + cardW - 38, top + 10, { width: 30, align: 'right', lineBreak: false })
      doc
        .font('Helvetica')
        .fontSize(6.6)
        .fillColor(INK.body)
        .text(pillarBlurb(p.key), x + 8, top + 34, { width: cardW - 16 })
      if (p.notAssessedCount > 0) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(5.8)
          .fillColor(INK.muted)
          .text(`Scored over ${p.assessedCount} of 5 checks.`, x + 8, top + h - 11, { width: cardW - 16, lineBreak: false })
      }
    })
    doc.y = top + h + 12
    atLeft(doc)
  }

  statTiles(doc, [
    { value: String(input.productPagesInspected), caption: 'Product pages inspected', color: INK.navy },
    { value: String(input.scorecard.assessedCount), caption: 'Checks assessed', color: INK.navy },
    {
      value: subject ? `${subject.observedCount + subject.derivedAttributeCount}` : '0',
      caption: 'Attributes found on page',
      color: INK.navy,
    },
    {
      value: subject ? `${subject.absentCount}` : '—',
      caption: 'Fields not published',
      color: INK.red,
    },
  ])

  sectionHeading(doc, 'Target SKU Specification & Audit Boundary')
  {
    const rows: Array<[string, string]> = subject
      ? [
          ['Product Name', subject.title],
          [
            'Manufacturer & MPN',
            [fieldValue(subject, 'product.brand'), fieldValue(subject, 'product.mpn')].filter(Boolean).join(' · Part # ') ||
              'Not published on current website',
          ],
          ['Distributor Item Code', fieldValue(subject, 'product.sku') ?? ABSENT],
          [
            'Taxonomy Path',
            plain(subject.pageContext?.breadcrumbs ?? '') || fieldValue(subject, 'product.category') || ABSENT,
          ],
          ['Audited URL', subject.sourceUrl],
          ['Pages Inspected', `${input.pagesInspected} page(s), of which ${input.productPagesInspected} were product pages`],
        ]
      : [
          [
            'Product Name',
            evidence?.state === 'product_candidate'
              ? `${evidence.entries.length} product(s) are named on this website; none is published on a product page`
              : evidence?.state === 'no_product_evidence'
                ? 'No product is named anywhere on this website'
                : evidence?.state === 'website_not_read'
                  ? 'This website was not read, so nothing is claimed about its catalogue'
                  : 'No product page carried enough published data to audit',
          ],
          ['Audited Site', input.website],
          ['Pages Inspected', `${input.pagesInspected} page(s), of which ${input.productPagesInspected} were product pages`],
          // The products the site really names, so a customer with a full
          // catalogue is never handed a report saying they have none.
          ...(evidence && evidence.entries.length > 0
            ? ([
                [
                  'Named on their pages',
                  evidence.entries
                    .slice(0, 6)
                    .map((e) => e.name)
                    .join(' · '),
                ],
              ] as Array<[string, string]>)
            : []),
        ]
    table(
      doc,
      [
        { header: 'Field', width: 0.24 },
        { header: 'As published on your site', width: 0.76 },
      ],
      rows.map(([k, v]) => [{ text: k, bold: true, color: INK.ink }, { text: clip(v, 180) }]),
      { bodySize: 7.6 },
    )
  }

  noteBox(doc, {
    label: 'Scope:',
    text: input.scopeNote,
    tint: INK.panel,
    edge: INK.navy,
    size: 7.2,
  })

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 2 — what was tested, and what was not
  // ═══════════════════════════════════════════════════════════════════════
  doc.addPage()
  header(doc, { logo, section: 'Assessment Coverage', reference })
  pageTitle(doc, 'What This Audit Measured', 'Assessment Coverage, Method, and the Limits of This Report')

  noteBox(doc, {
    label: 'Methodology Note:',
    text:
      `Every check in this report was run against ${input.website} as an ordinary logged-out visitor sees it. ` +
      `Each finding names the thing on the page it was read from, so any line here can be checked against your own site.`,
  })

  sectionHeading(doc, 'What Was Assessed')
  table(
    doc,
    [
      { header: 'Pillar', width: 0.3 },
      { header: 'Checks run', width: 0.18, align: 'right' },
      { header: 'Score', width: 0.14, align: 'right' },
      { header: 'Weight', width: 0.14, align: 'right' },
      { header: 'What it measures', width: 0.24 },
    ],
    input.scorecard.pillars.map((p) => [
      { text: p.title, bold: true, color: INK.ink },
      { text: `${p.assessedCount} of ${p.checks.length}` },
      { text: String(p.score), bold: true, color: p.score >= 60 ? INK.green : INK.red },
      { text: `${p.weightPct}%` },
      { text: p.subtitle },
    ]),
    { bodySize: 7.8 },
  )

  // The honest half of this page. The sample report carries live query logs
  // from five answer engines here; producing those needs a harness this
  // platform does not have, and inventing three plausible transcripts would
  // be the single most damaging thing this document could do.
  sectionHeading(doc, 'What Was Not Assessed, and Why')
  if (input.scorecard.notAssessed.length === 0) {
    noteBox(doc, {
      text: 'All fifteen checks were run against the live page. Nothing in this report is estimated.',
      tint: INK.panelGreen,
      edge: INK.green,
    })
  } else {
    table(
      doc,
      [
        { header: 'Ref', width: 0.08 },
        { header: 'Check', width: 0.28 },
        { header: 'Why it is not in the score', width: 0.44 },
        { header: 'Status', width: 0.2 },
      ],
      input.scorecard.notAssessed.map((n) => [
        { text: n.ref, bold: true, color: INK.ink },
        { text: n.metric },
        { text: n.reason },
        { text: 'NOT ASSESSED', bold: true, color: INK.muted },
      ]),
      { bodySize: 7.8 },
    )
    noteBox(doc, {
      label: 'Why this matters:',
      text:
        `The overall index above is ${input.scorecard.denominatorNote.charAt(0).toLowerCase()}${input.scorecard.denominatorNote.slice(1)} ` +
        'A check that was not run is shown as not assessed rather than scored as zero, because a zero would read as a failure that was measured. ' +
        'Live answer-engine testing and off-domain citation analysis are available as a separate exercise.',
      tint: INK.panelAmber,
      edge: INK.amber,
      size: 7.4,
    })
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 3 — the 15-point scorecard
  // ═══════════════════════════════════════════════════════════════════════
  doc.addPage()
  header(doc, { logo, section: '15-Point Scorecard', reference })
  pageTitle(doc, 'The 15-Point Scorecard', 'Evaluation Across Findability, Comprehension, and Recommendation Pillars')

  for (const p of input.scorecard.pillars) {
    doc
      .font('Helvetica-Bold')
      .fontSize(8.4)
      .fillColor(INK.navy)
      .text(
        `PILLAR ${input.scorecard.pillars.indexOf(p) + 1}: ${p.title.toUpperCase()} (SCORE: ${p.score} / 100 · WEIGHT: ${p.weightPct}%)`,
        PAGE.margin,
        doc.y,
        { width: W },
      )
    doc.y += 5
    atLeft(doc)
    table(
      doc,
      [
        { header: 'Ref', width: 0.07 },
        { header: 'Evaluation Metric', width: 0.23 },
        { header: 'Technical Diagnostic Finding', width: 0.53 },
        { header: 'Status', width: 0.17 },
      ],
      p.checks.map((c) => [
        { text: c.ref, bold: true, color: INK.ink },
        { text: c.metric },
        { text: c.finding },
        { text: statusWord(c.status), bold: true, color: statusInk(c.status) },
      ]),
      { bodySize: 7.1 },
    )
    doc.y += 3
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 4 — what good looks like
  // ═══════════════════════════════════════════════════════════════════════
  doc.addPage()
  header(doc, { logo, section: 'SKU Transformation Study', reference })
  pageTitle(
    doc,
    'What Good Looks Like',
    subject ? `SKU Transformation Study: ${clip(subject.title, 70)}` : 'SKU Transformation Study',
  )

  if (!subject) {
    noteBox(doc, {
      label: 'No case study:',
      text:
        'The inspected pages did not publish enough structured product information to build a before-and-after example. ' +
        'That is itself the finding: there is currently no product record on these pages for a buyer, a marketplace or an ' +
        'answer engine to read. No example has been invented in its place.',
      tint: INK.panelRed,
      edge: INK.red,
    })
  } else {
    noteBox(doc, {
      label: 'Transformation Objective:',
      text:
        'Turn what this page already states into a record an engine can parse, validate and cite — without adding a single ' +
        'fact the page does not support.',
      tint: INK.panel,
      edge: INK.navy,
    })

    const { colW, leftX, rightX, top } = beforeAfterHeads(
      doc,
      'AS PUBLISHED TODAY (Current State)',
      'STRUCTURED, AI-DISCOVERABLE (Remediated)',
    )

    doc.font('Helvetica').fontSize(6.8).fillColor(INK.muted)
    doc.text(`URL: ${pathOf(subject.sourceUrl)}`, leftX + 7, top + 7, { width: colW - 14 })
    doc.text('AltiusNxt structured record', rightX + 7, top + 7, { width: colW - 14 })

    const beforeText = subject.beforeSummary
    const afterText = subject.afterSummary
    doc.font('Helvetica').fontSize(7.2)
    const bodyH =
      Math.max(
        doc.heightOfString(beforeText, { width: colW - 18 }),
        doc.heightOfString(afterText, { width: colW - 18 }),
      ) + 16
    const bodyTop = top + 20
    doc.rect(leftX, bodyTop, colW, bodyH).fill(INK.panelRed)
    doc.rect(rightX, bodyTop, colW, bodyH).fill(INK.panelGreen)
    doc.fillColor(INK.body).font('Helvetica').fontSize(7.2)
    doc.text(beforeText, leftX + 9, bodyTop + 8, { width: colW - 18 })
    doc.text(afterText, rightX + 9, bodyTop + 8, { width: colW - 18 })
    doc.y = bodyTop + bodyH + 4

    // The attribute ledger under each column.
    const ledgerTop = doc.y
    const leftRows: Array<[string, string]> = [
      ['Attributes published as fields', String(subject.observedCount)],
      ['Attributes stated only in prose', String(subject.derivedAttributeCount)],
      ['Fields not published at all', String(subject.absentCount)],
      ['Structured data', input.scorecard.pillars[0]!.checks.find((c) => c.ref === 'A3')!.status === 'pass' ? 'Present' : 'None detected'],
    ]
    const rightRows: Array<[string, string]> = input.recommendedAttributes
      .slice(0, 5)
      .map((a) => [
        a.label,
        a.value ? clip(a.value, 40) : a.state === 'recommended' ? 'Recommended field' : 'Not published',
      ])

    doc.font('Helvetica').fontSize(6.9)
    const rowH = 11
    leftRows.forEach(([k, v], i) => {
      const y = ledgerTop + i * rowH
      doc.fillColor(INK.body).font('Helvetica-Bold').text(k, leftX + 9, y, { width: colW * 0.62, lineBreak: false })
      doc.fillColor(INK.red).font('Helvetica-Bold').text(v, leftX + 9, y, { width: colW - 18, align: 'right', lineBreak: false })
    })
    rightRows.forEach(([k, v], i) => {
      const y = ledgerTop + i * rowH
      doc.fillColor(INK.body).font('Helvetica-Bold').text(k, rightX + 9, y, { width: colW * 0.5, lineBreak: false })
      doc.fillColor(INK.green).font('Helvetica-Bold').text(v, rightX + 9, y, { width: colW - 18, align: 'right', lineBreak: false })
    })
    doc.y = ledgerTop + Math.max(leftRows.length, rightRows.length) * rowH + 12
    atLeft(doc)

    sectionHeading(doc, 'Why Answer Engines Treat These Differently')
    const reasons: Array<[string, string]> = [
      [
        '1. Named fields instead of a paragraph',
        `${subject.derivedAttributeCount} attribute(s) on this page are stated only inside the description text. A buyer cannot filter on a sentence, and a feed cannot carry one.`,
      ],
      [
        '2. Stated absence instead of silence',
        `${subject.absentCount} field(s) are not published anywhere on the page. Naming them is what turns an invisible gap into a work item.`,
      ],
      [
        '3. The same words, in a machine-readable shape',
        'Nothing in the remediated column is new information. It is this page’s own values, moved into fields an engine can read.',
      ],
    ]
    for (const [head, body] of reasons) {
      doc.font('Helvetica-Bold').fontSize(7.6).fillColor(INK.ink).text(head, PAGE.margin, doc.y, { width: W })
      doc.font('Helvetica').fontSize(7.4).fillColor(INK.body).text(body, PAGE.margin, doc.y + 1, { width: W })
      doc.y += 5
      atLeft(doc)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 5 — visual comparison matrix
  // ═══════════════════════════════════════════════════════════════════════
  doc.addPage()
  header(doc, { logo, section: 'Visual Architecture Benchmark', reference })
  pageTitle(doc, 'Visual Comparison Matrix', 'Your Product Page Today, and the Same Page Structured')

  if (!subject) {
    noteBox(doc, {
      // The state's own words, written once on the server and printed
      // verbatim here, so the document and the Workbench screen say the same
      // thing about the same run.
      label: evidence ? evidence.headline : undefined,
      text: evidence
        ? `${evidence.detail} Nothing has been mocked up in its place.`
        : 'No product page carried enough published data to draw a comparison. Nothing has been mocked up in its place.',
      tint: INK.panelRed,
      edge: INK.red,
    })
  } else {
    drawWireframes(doc, subject, opened, input)
    sectionHeading(doc, 'Core Architectural Differentiator')
    noteBox(doc, {
      label: 'Identical product — different machine readability:',
      text:
        'The product is the same in both frames, and every value in the right-hand frame came from the left. What changes is ' +
        'whether a buyer’s filter, a marketplace feed or an answer engine can reach those values, or whether they are only ' +
        'visible to a person reading the page.',
      tint: INK.panel,
      edge: INK.navy,
    })

    // THE SAME PROPOSAL THE WORKBENCH SHOWS, labelled as a proposal.
    //
    // Carried in from the customer view, so the wording a customer reads in
    // the PDF is the wording they see on the screen — not a second attempt at
    // the same idea. Its own box and its own label, because this is the one
    // block on the page that is OURS rather than theirs: everything else in
    // both frames is a value their page published.
    //
    // Omitted entirely when the page published too little to compose from.
    // Nothing is written in its place.
    if (input.proposedContent) {
      noteBox(doc, {
        label: 'Proposed wording — a suggestion, not a finding:',
        text: clip(input.proposedContent.overview, 420),
        tint: INK.panelAmber,
        edge: INK.amber,
        size: 7.2,
      })
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 6 — remediation roadmap
  // ═══════════════════════════════════════════════════════════════════════
  doc.addPage()
  header(doc, { logo, section: 'Strategic Remediation Roadmap', reference })
  pageTitle(doc, 'Strategic Remediation Roadmap', 'Prioritised Action Plan, Drawn From the Checks That Failed')

  if (input.remediation.length === 0) {
    noteBox(doc, {
      text: 'No check failed on the audited page, so there is no remediation to propose from this audit.',
      tint: INK.panelGreen,
      edge: INK.green,
    })
  } else {
    sectionHeading(doc, `${numberWord(input.remediation.length)} High-Leverage Fixes (In Order of Impact)`)
    input.remediation.forEach((fix, i) => {
      const inner = W - 24
      doc.font('Helvetica').fontSize(7.4)
      // Measured against the SAME strings the loop below prints, including the
      // new BEFORE line. A card sized for three lines and printed with four
      // overflows its own border and pushes the roadmap onto an eighth page.
      const beforeLine = fix.observedBefore.length
        ? doc.heightOfString(`On your page today: ${fix.observedBefore.join(' · ')}`, { width: inner })
        : 0
      const h =
        26 +
        beforeLine +
        doc.heightOfString(`Problem: ${fix.currentGap}`, { width: inner }) +
        doc.heightOfString(`Recommended change: ${fix.remediation}`, { width: inner }) +
        doc.heightOfString(`Expected improvement: ${fix.impact}`, { width: inner }) +
        14
      const top = doc.y
      doc.rect(PAGE.margin, top, W, h).lineWidth(0.6).strokeColor(INK.rule).stroke()
      doc.circle(PAGE.margin + 17, top + 13, 7).fill(INK.red)
      doc
        .font('Helvetica-Bold')
        .fontSize(7.4)
        .fillColor(INK.white)
        .text(String(i + 1), PAGE.margin + 10, top + 10, { width: 14, align: 'center', lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(8.4).fillColor(INK.navy).text(fix.title, PAGE.margin + 30, top + 8, {
        width: W - 40,
      })

      let y = top + 24
      // BEFORE → PROBLEM → RECOMMENDED CHANGE → EXPECTED IMPROVEMENT.
      //
      // The order is the argument. It opens on the customer's own page, quoted
      // back to them from the audit's own basis, so the problem beneath it is
      // read as a consequence of something they can go and check rather than as
      // an opinion about their website. A recommendation that arrives before
      // the observation it rests on is the thing a reader argues with.
      //
      // The BEFORE line is omitted entirely when the check recorded no basis.
      // A heading with nothing under it would be worse than no heading.
      for (const [label, text] of (
        [
          fix.observedBefore.length ? ['On your page today:', fix.observedBefore.join(' · ')] : null,
          ['Problem:', fix.currentGap],
          ['Recommended change:', fix.remediation],
          ['Expected improvement:', fix.impact],
        ] as Array<[string, string] | null>
      ).filter((r): r is [string, string] => r !== null)) {
        doc.font('Helvetica-Bold').fontSize(7.4).fillColor(INK.ink).text(label, PAGE.margin + 12, y, { continued: true })
        doc.font('Helvetica').fillColor(INK.body).text(` ${text}`, { width: inner })
        y = doc.y + 1
      }
      doc
        .font('Helvetica')
        .fontSize(6.8)
        .fillColor(INK.muted)
        .text(
          `Addresses: ${fix.addresses.join(', ')}  ·  Effort: ${fix.effort}  ·  Primary owner: ${fix.owner}`,
          PAGE.margin + 12,
          y + 1,
          { width: inner },
        )
      doc.y = top + h + 8
      atLeft(doc)
    })
  }

  sectionHeading(doc, 'The AltiusNxt 7-Layer Catalogue Framework')
  drawLayers(doc)

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 7 — methodology and sign-off
  // ═══════════════════════════════════════════════════════════════════════
  doc.addPage()
  header(doc, { logo, section: 'Formal Sign-Off & Action Plan', reference })
  pageTitle(doc, 'Methodology & Practice Sign-Off', 'Governance, Quality Control, and Commercial Next Steps')

  sectionHeading(doc, 'Audit Scope Boundaries & Methodology')
  doc
    .font('Helvetica')
    .fontSize(7.6)
    .fillColor(INK.body)
    .text(
      `Product data and page structure were read directly from ${input.website} as a logged-out visitor sees it. ` +
        `${input.scopeNote} ` +
        `${input.scorecard.denominatorNote} ` +
        'This assessment covers AI discoverability only; it excludes server performance, checkout paths and negotiated pricing tiers.',
      PAGE.margin,
      doc.y,
      { width: W },
    )
  doc.y += 12
  atLeft(doc)

  // Governance block, from the real approval record.
  {
    const top = doc.y
    const h = 96
    doc.rect(PAGE.margin, top, W, h).lineWidth(1).strokeColor(INK.navy).stroke()
    doc
      .font('Helvetica-Bold')
      .fontSize(8.6)
      .fillColor(INK.navy)
      .text('AUDIT GOVERNANCE & APPROVAL', PAGE.margin + 14, top + 12, { width: W - 28, characterSpacing: 0.4 })
    doc.moveTo(PAGE.margin + 14, top + 27).lineTo(PAGE.margin + W - 14, top + 27).lineWidth(0.8).strokeColor(INK.red).stroke()

    const colW = (W - 40) / 2
    const cols: Array<{ x: number; eyebrow: string; who: { name: string; role: string; email?: string | null } | null; none: string }> = [
      {
        x: PAGE.margin + 14,
        eyebrow: 'PREPARED & GENERATED BY',
        who: input.preparedBy,
        none: '',
      },
      {
        x: PAGE.margin + 26 + colW,
        eyebrow: 'REVIEWED & FORMALLY APPROVED BY',
        who: input.approvedBy,
        none: 'Not yet approved — this copy is not cleared for distribution.',
      },
    ]
    for (const c of cols) {
      doc
        .font('Helvetica-Bold')
        .fontSize(6.6)
        .fillColor(INK.muted)
        .text(c.eyebrow, c.x, top + 36, { width: colW, characterSpacing: 0.4 })
      if (c.who) {
        doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK.navy).text(c.who.name, c.x, top + 47, { width: colW })
        doc.font('Helvetica-Bold').fontSize(7.8).fillColor(INK.red).text(c.who.role, c.x, top + 60, { width: colW })
        doc
          .font('Helvetica')
          .fontSize(7.2)
          .fillColor(INK.body)
          .text(
            ['AltiusNxt Technologies Pvt Ltd', c.who.email].filter(Boolean).join(' · '),
            c.x,
            top + 70,
            { width: colW },
          )
      } else {
        doc.font('Helvetica-Oblique').fontSize(7.8).fillColor(INK.red).text(c.none, c.x, top + 49, { width: colW })
      }
      doc.moveTo(c.x, top + 84).lineTo(c.x + colW, top + 84).lineWidth(0.5).strokeColor(INK.rule).stroke()
    }
    doc.y = top + h + 12
    atLeft(doc)
  }

  sectionHeading(doc, 'Recommended Next Step')
  {
    const top = doc.y
    const h = input.workbenchUrl ? 82 : 52
    doc.rect(PAGE.margin, top, W, h).fill(INK.panel)
    const textX = input.workbenchUrl ? PAGE.margin + 86 : PAGE.margin + 14
    const textW = W - (textX - PAGE.margin) - 14

    if (input.workbenchUrl) {
      const qr = await QRCode.toBuffer(input.workbenchUrl, { type: 'png', margin: 1, width: 320, errorCorrectionLevel: 'M' })
      const qrImg = (doc as DocWithOpenImage).openImage(qr)
      doc.image(asSrc(qrImg), PAGE.margin + 14, top + 11, { width: 60, height: 60 })
    }
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK.navy).text(input.ctaLabel, textX, top + 13, { width: textW })
    doc.font('Helvetica').fontSize(7.8).fillColor(INK.body).text(input.nextStep, textX, top + 28, { width: textW })
    if (input.workbenchUrl) {
      doc
        .font('Helvetica')
        .fontSize(6.6)
        .fillColor(INK.muted)
        .text(input.workbenchUrl, textX, top + h - 16, { width: textW })
    }
    doc.y = top + h + 12
    atLeft(doc)
  }

  if (input.legalDisclaimer?.trim()) {
    doc.font('Helvetica').fontSize(6.6).fillColor(INK.faint).text(input.legalDisclaimer, PAGE.margin, doc.y, { width: W })
  } else {
    const warn = 'NOT FOR CUSTOMER DISTRIBUTION — no approved legal disclaimer is configured for this environment.'
    const h = doc.heightOfString(warn, { width: W - 20 }) + 12
    doc.rect(PAGE.margin, doc.y, W, h).fill(INK.panelRed)
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor(INK.red).text(warn, PAGE.margin + 10, doc.y + 6, { width: W - 20 })
  }

  const pageCount = footers(doc, {
    label: `${FOOTER}  ·  Prepared for ${input.preparedFor}`,
    watermark: input.reviewWatermark ?? null,
  })

  doc.end()
  await finished
  const bytes = Buffer.concat(chunks)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), pageCount }
}

// ── Page-local helpers ────────────────────────────────────────────────────

function executiveFinding(input: PdpReportInput): string {
  const s = input.scorecard
  const weakest = [...s.pillars].sort((a, b) => a.score - b.score)[0]!
  if (!input.subject) {
    return (
      `No inspected page on ${pathOf(input.website)} published enough structured product data to audit as a product record. ` +
      'That absence is the finding.'
    )
  }
  return (
    `Scored ${s.overall} of 100 across ${s.assessedCount} checks run against a live product page. ` +
    `The weakest pillar is “${weakest.title}” at ${weakest.score}. ` +
    `${input.subject.absentCount} field(s) a buyer would filter on are not published anywhere on the audited page.`
  )
}

function pillarBlurb(key: 'find' | 'understand' | 'recommend'): string {
  switch (key) {
    case 'find':
      return 'Crawler access, canonical integrity, structured data depth, and identifier resolution.'
    case 'understand':
      return 'Attribute completeness, units, taxonomy placement, and the semantic depth of the copy.'
    default:
      return 'Differentiation, authority signals, commercial visibility, and buyer-question coverage.'
  }
}

function numberWord(n: number): string {
  return ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'][n] ?? String(n)
}

/**
 * The two PDP wireframes.
 *
 * The left frame is the customer's page as observed. The right frame is the
 * same product with its own values in named fields. The product image is the
 * REAL one from their site in both frames, because the point being made is
 * "this is your page", and a stock photograph would undo it.
 */
function drawWireframes(
  doc: Doc,
  rec: EnrichedRecord,
  opened: Map<string, OpenedImage>,
  input: PdpReportInput,
): void {
  const { colW, leftX, rightX, top } = beforeAfterHeads(
    doc,
    'AS PUBLISHED TODAY (PDP WIREFRAME)',
    'STRUCTURED, AI-DISCOVERABLE',
  )
  const frameH = 232
  // The captured shell, or null. Read once and used by both frames, so the two
  // sides cannot differ in anything except what the page publishes.
  const shell = input.websiteShell?.captured ? input.websiteShell : null
  doc.rect(leftX, top, colW, frameH).lineWidth(0.7).strokeColor(INK.red).stroke()
  doc.rect(rightX, top, colW, frameH).lineWidth(0.7).strokeColor(INK.green).stroke()

  const img = rec.imageUrl ? opened.get(rec.imageUrl) : null
  const crumbs = plain(rec.pageContext?.breadcrumbs ?? '') || fieldValue(rec, 'product.category')
  const a3 = input.scorecard.pillars[0]!.checks.find((c) => c.ref === 'A3')!
  const price = fieldValue(rec, 'product.price')
  const availability = fieldValue(rec, 'product.availability')
  const documents = fieldValue(rec, 'product.documents')
  const priceIsReal = Boolean(price && price.trim() !== '' && price.trim() !== '0')

  const frame = (x: number, side: 'before' | 'after') => {
    let y = top + 8

    // ── THE CUSTOMER'S OWN MASTHEAD, IN BOTH FRAMES ──────────────────────
    //
    // Drawn from the shell the customer view captured — the same capture the
    // Workbench renders, handed in rather than sampled again. It goes in BOTH
    // frames on purpose: the point being made is "this is your page, and this
    // is the same page done properly", and a masthead that appears only on the
    // right would make the right-hand frame look like a different website.
    //
    // Every element is drawn only if it was captured. Nothing substitutes for
    // a logo, a site name or a navigation this run never read.
    const shellName = shell?.captured ? shell.siteName : null
    const shellNav = shell?.captured ? shell.nav.slice(0, 4).map((n) => n.label) : []
    if (shellName || shellNav.length) {
      doc.rect(x + 1, top + 1, colW - 2, 15).fill(INK.panel)
      if (shellName) {
        doc
          .font('Helvetica-Bold')
          .fontSize(6.6)
          .fillColor(INK.navy)
          .text(clip(shellName, 30), x + 9, top + 4, { width: colW * 0.45, lineBreak: false })
      }
      if (shellNav.length) {
        doc
          .font('Helvetica')
          .fontSize(5.4)
          .fillColor(INK.muted)
          .text(shellNav.join('   ·   '), x + 9 + colW * 0.45, top + 5, {
            width: colW * 0.55 - 18,
            align: 'right',
            lineBreak: false,
          })
      }
      y = top + 20
    }

    doc.font('Helvetica').fontSize(6.4).fillColor(INK.muted)
    doc.text(pathOf(rec.sourceUrl), x + 9, y, { width: colW - 18, lineBreak: false })
    y += 9
    doc.fontSize(5.9).fillColor(INK.faint)
    doc.text(crumbs ? clip(crumbs, 70) : 'No breadcrumb published', x + 9, y, { width: colW - 18, lineBreak: false })
    y += 11

    // The real product image, in both frames.
    const boxH = 62
    doc.rect(x + 9, y, colW - 18, boxH).fill(INK.panel)
    if (img) {
      const scale = Math.min((colW - 26) / img.width, (boxH - 8) / img.height, 1)
      const w = img.width * scale
      const h = img.height * scale
      doc.image(asSrc(img), x + 9 + (colW - 18 - w) / 2, y + (boxH - h) / 2, { width: w, height: h })
    } else if (side === 'after') {
      // The improved frame shows WHERE product photography belongs, labelled
      // as an example. Never a stock photograph: a picture of some other
      // product in the customer's own frame would be a fabrication.
      doc
        .font('Helvetica-Bold')
        .fontSize(5.8)
        .fillColor(EXAMPLE_INK)
        .text('EXAMPLE', x + 9, y + boxH / 2 - 12, { width: colW - 18, align: 'center', lineBreak: false })
      doc
        .font('Helvetica')
        .fontSize(6.2)
        .fillColor(EXAMPLE_INK)
        .text('Product photography goes here', x + 9, y + boxH / 2 - 3, { width: colW - 18, align: 'center', lineBreak: false })
    } else {
      doc
        .font('Helvetica')
        .fontSize(6.4)
        .fillColor(INK.faint)
        .text('No product image published on this page', x + 9, y + boxH / 2 - 4, { width: colW - 18, align: 'center', lineBreak: false })
    }
    y += boxH + 8

    doc.font('Helvetica-Bold').fontSize(8).fillColor(INK.ink)
    doc.text(clip(rec.title, 82), x + 9, y, { width: colW - 18 })
    y = doc.y + 5

    // Signal chips.
    let cx = x + 9
    if (side === 'before') {
      cx += chip(doc, cx, y, a3.status === 'pass' ? 'Structured data' : 'No structured data', a3.status === 'pass' ? 'ok' : 'bad')
      cx += chip(doc, cx, y, documents ? 'Datasheet linked' : 'No datasheet', documents ? 'ok' : 'bad')
      chip(doc, cx, y, priceIsReal ? clip(price!, 14) : 'No public price', priceIsReal ? 'warn' : 'bad')
    } else {
      cx += chip(doc, cx, y, 'JSON-LD schema', 'ok')
      cx += chip(doc, cx, y, documents ? 'Datasheet linked' : 'Datasheet recommended', documents ? 'ok' : 'warn')
      chip(doc, cx, y, priceIsReal ? `${clip(price!, 12)}${availability ? ' · in stock' : ''}` : 'Publish price', priceIsReal ? 'ok' : 'warn')
    }
    y += 15

    // Spec rows: the same attributes on both sides, differently shaped.
    const specs: Array<[string, string, string]> =
      side === 'before'
        ? rec.fields
            .filter((f) => f.state !== 'absent' && f.before !== null && f.field !== 'product.name')
            .slice(0, 5)
            .map((f) => [f.label, clip(plain(f.before!), 34), INK.body])
        : [
            ...rec.fields
              .filter((f) => f.state !== 'absent' && f.before !== null && f.field !== 'product.name')
              .slice(0, 3)
              .map((f): [string, string, string] => [f.label, clip(plain(f.before!), 30), INK.body]),
            ...input.recommendedAttributes
              .filter((a) => a.value)
              .slice(0, 2)
              .map((a): [string, string, string] => [a.label, clip(a.value!, 28), INK.green]),
            // The fields this page leaves empty, filled with a labelled
            // EXAMPLE of what the finished field looks like — the same
            // examples the Workbench shows. The frame's own height check
            // below stops these before they can overrun the border.
            ...rec.fields
              .filter((f) => f.state === 'absent' && !f.before && input.illustrativeExamples?.[f.field])
              .slice(0, 3)
              .map((f): [string, string, string] => [
                f.label,
                `EXAMPLE  ${clip(input.illustrativeExamples![f.field]!.value, 26)}`,
                EXAMPLE_INK,
              ]),
          ]

    doc.font('Helvetica').fontSize(6.4)
    for (const [k, v, colour] of specs) {
      if (y > top + frameH - 26) break
      doc.fillColor(INK.muted).text(k, x + 9, y, { width: colW * 0.46, lineBreak: false })
      doc.font('Helvetica-Bold').fillColor(colour).text(v, x + 9, y, { width: colW - 18, align: 'right', lineBreak: false })
      doc.font('Helvetica')
      doc.moveTo(x + 9, y + 9).lineTo(x + colW - 9, y + 9).lineWidth(0.3).strokeColor(INK.hair).stroke()
      y += 12
    }

    // The applications line.
    const desc = fieldValue(rec, 'product.description')
    doc.font('Helvetica').fontSize(6.2).fillColor(side === 'before' ? INK.muted : INK.body)
    doc.text(
      side === 'before'
        ? desc
          ? `Description: ${clip(desc, 130)}`
          : 'No product description published.'
        : rec.keyTransformation
          ? clip(rec.keyTransformation, 150)
          : 'The page’s own values, in named fields.',
      x + 9,
      Math.min(y + 3, top + frameH - 22),
      { width: colW - 18, height: 18 },
    )
  }

  frame(leftX, 'before')
  frame(rightX, 'after')

  // Their own footer line, once, in the gap that already exists beneath the
  // two frames. Printed only when the run captured one — a site whose footer
  // could not be read shows none, and nothing is written in its place.
  //
  // Below the frames rather than inside them: the frame's last rows are the
  // product's own specifications and its description, and squeezing a footer
  // in under those would mean shortening the customer's data to fit our
  // furniture. The gap was already there.
  if (shell?.footerText) {
    doc
      .font('Helvetica')
      .fontSize(5.4)
      .fillColor(INK.faint)
      .text(clip(shell.footerText, 90), leftX, top + frameH + 2, { width: colW * 2 + 12, lineBreak: false })
  }

  doc.y = top + frameH + 12
  atLeft(doc)
}

/** The seven-layer framework grid: approved marketing copy, not a finding. */
function drawLayers(doc: Doc): void {
  const LAYERS: Array<[string, string]> = [
    ['Raw Spec Ingestion', 'Parse PDP, ERP and PIM feeds and manufacturer cut sheets.'],
    ['Attribute Normalization', 'Standardise units, thread pitches and taxonomy classifications.'],
    ['Engineering QC', 'Human sign-off on every dimension; zero hallucination tolerance.'],
    ['Cross-Ref & Mating', 'Map compatible parts, accessories and consumables.'],
    ['Semantic Schema Architecture', 'Deploy nested JSON-LD graphs built for crawler indexing.'],
    ['Regional Intent Anchors', 'Embed fulfilment centres, sector tags and local availability.'],
    ['Continuous Validation', 'Repeat regression testing as the catalogue changes.'],
  ]
  const gap = 6
  const perRow = 4
  const cardW = (W - gap * (perRow - 1)) / perRow
  const h = 52
  let top = doc.y
  LAYERS.forEach(([title, body], i) => {
    const row = Math.floor(i / perRow)
    const col = i % perRow
    const x = PAGE.margin + col * (cardW + gap)
    const y = top + row * (h + gap)
    doc.rect(x, y, cardW, h).lineWidth(0.6).strokeColor(INK.rule).stroke()
    doc
      .font('Helvetica-Bold')
      .fontSize(5.8)
      .fillColor(INK.red)
      .text(`LAYER ${i + 1}`, x + 7, y + 7, { width: cardW - 14, characterSpacing: 0.4, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(7.4).fillColor(INK.navy).text(title, x + 7, y + 16, { width: cardW - 14 })
    doc.font('Helvetica').fontSize(6.2).fillColor(INK.body).text(body, x + 7, y + 30, { width: cardW - 14 })
  })
  top += Math.ceil(LAYERS.length / perRow) * (h + gap)
  doc.y = top
  atLeft(doc)
}
