import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import PDFDocument from 'pdfkit'
import QRCode from 'qrcode'
import type { EnrichedAttribute, PdpEnrichment } from './pdpEnrichment.js'

// THE PDP ENRICHMENT REPORT.
//
// Laid out after the approved template (PDP_Enrichment_Report_Francis_Arete_Ltd):
//
//   1  Product Data Page (PDP) Enrichment Report — introduction, summary table,
//      strategic executive summary
//   2  Case Study 01 — Before / After narrative, key transformation, key
//      enriched attributes
//   3  Original product page — a capture of the customer's page
//   4  Enriched result — a capture of the enriched product page
//   5  Full technical specification matrix — with standardisation notes
//   6  Summary & next steps — key improvements, recommended next steps, sign-off
//
// Every word of content comes from the stored enrichment (see pdpEnrichment.ts)
// or the run; nothing here composes a claim. Values proposed by enrichment are
// marked in the matrix with an asterisk and footnoted, so the document shows
// the finished record without passing a proposal off as verified data.

const PAGE_W = 595.28
const PAGE_H = 841.89
const M = 48
const W = PAGE_W - M * 2
const BOTTOM = PAGE_H - 70

const C = {
  ink: '#111827',
  body: '#374151',
  muted: '#6b7280',
  faint: '#9ca3af',
  rule: '#e5e7eb',
  red: '#dc2626',
  blue: '#1d6fb8',
  blueText: '#0b5394',
  panelBlue: '#eef4fb',
  green: '#15803d',
  panelGreen: '#effaf1',
  slate: '#475569',
  labelBg: '#f8fafc',
  violet: '#6d28d9',
}

type Doc = PDFKit.PDFDocument
type Opened = { width: number; height: number }

export interface EnrichmentReportInput {
  companyName: string
  /** "Francis, Arete Ltd" — a contact name when NXT Sales records one. */
  preparedFor: string
  preparedBy: { name: string; role: string; company: string; phone: string | null; email: string | null; web: string | null }
  auditDate: Date
  sourceUrl: string
  enrichment: PdpEnrichment
  beforeCapture: Buffer | null
  afterCapture: Buffer | null
  /** Why a capture is missing, stated on its page rather than left blank. */
  captureNote: string | null
  logoPath: string | null
  /** A share link, rendered as a QR on the sign-off page. Approved copies only. */
  shareUrl: string | null
  /** Set on an unapproved copy. */
  watermark: string | null
}

export interface EnrichmentReportResult {
  bytes: Buffer
  sha256: string
  pageCount: number
}

/** The standard PDF fonts are WinAnsi: map what they cannot draw. */
export function pdfText(s: string | null | undefined): string {
  return String(s ?? '')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/[″“”]/g, '"')
    .replace(/[′‘’]/g, "'")
    .replace(/[‐‑‒−]/g, '-')
    .replace(/…/g, '...')
    .replace(/[^\u0020-\u00ff\n\u20ac\u2013\u2014\u2022\u2122\u2030\u0152\u0153]/g, '')
}

export async function renderEnrichmentReport(input: EnrichmentReportInput): Promise<EnrichmentReportResult> {
  const e = input.enrichment.enriched
  if (!e) throw new Error('The enrichment has no enriched record to report on.')

  const doc: Doc = new PDFDocument({
    size: 'A4',
    margin: M,
    bufferPages: true,
    info: {
      Title: `PDP Enrichment Report — ${input.companyName}`,
      Author: input.preparedBy.company,
      Subject: `Product Data Page enrichment report for ${input.companyName}`,
      CreationDate: input.auditDate,
      ModDate: input.auditDate,
    },
  })
  const chunks: Buffer[] = []
  doc.on('data', (c: Buffer) => chunks.push(c))
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()))

  let logo: Opened | null = null
  if (input.logoPath) {
    try {
      logo = (doc as Doc & { openImage(b: Buffer): Opened }).openImage(readFileSync(input.logoPath))
    } catch {
      logo = null
    }
  }
  const image = (bytes: Buffer | null): Opened | null => {
    if (!bytes) return null
    try {
      return (doc as Doc & { openImage(b: Buffer): Opened }).openImage(bytes)
    } catch {
      return null
    }
  }

  const company = pdfText(input.companyName)
  const date = input.auditDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })

  const header = () => {
    if (logo) doc.image(logo as never, M, 34, { height: 18 })
    else doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text('AltiusNxt', M, 36, { lineBreak: false })
    doc.rect(M, 58, 46, 1.6).fill(C.red)
    doc.font('Helvetica-Bold').fontSize(11).fillColor(C.ink).text('PDP ENRICHMENT REPORT', M, 36, { width: W, align: 'right' })
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted).text(pdfText(input.preparedBy.company), M, 52, { width: W, align: 'right' })
    doc.moveTo(M, 68).lineTo(M + W, 68).lineWidth(1.4).strokeColor(C.rule).stroke()
    doc.y = 88
    doc.x = M
  }
  const newPage = () => {
    doc.addPage()
    header()
  }
  const ensure = (h: number) => {
    if (doc.y + h > BOTTOM) newPage()
  }
  const para = (text: string, opts: { size?: number; color?: string; gap?: number; justify?: boolean } = {}) => {
    const t = pdfText(text)
    doc.font('Helvetica').fontSize(opts.size ?? 9.3)
    ensure(doc.heightOfString(t, { width: W }) + 4)
    doc.fillColor(opts.color ?? C.body).text(t, M, doc.y, { width: W, align: opts.justify === false ? 'left' : 'justify', lineGap: 2 })
    doc.y += opts.gap ?? 8
  }
  const heading = (text: string, size = 12.5, color = C.ink) => {
    ensure(40)
    doc.font('Helvetica-Bold').fontSize(size).fillColor(color).text(pdfText(text), M, doc.y, { width: W })
    doc.y += 5
  }
  const eyebrow = (text: string) => {
    ensure(30)
    doc.font('Helvetica-Bold').fontSize(9).fillColor(C.muted).text(pdfText(text).toUpperCase(), M, doc.y, { width: W, characterSpacing: 0.8 })
    doc.y += 4
  }
  /** A bold lead-in followed by body text, as a bullet. */
  const leadBullet = (lead: string, detail: string, marker: string) => {
    const x = M + 8
    const width = W - 22
    const text = `${pdfText(lead)}: ${pdfText(detail)}`
    doc.font('Helvetica').fontSize(8.8)
    const h = doc.heightOfString(text, { width }) + 4
    ensure(h)
    const top = doc.y
    doc.font('Helvetica').fontSize(8.8).fillColor(C.ink).text(marker, M, top, { width: 14, lineBreak: false })
    doc.font('Helvetica-Bold').fontSize(8.8).fillColor(C.ink).text(`${pdfText(lead)}: `, x + 6, top, { width, continued: true, lineGap: 1.5 })
    doc.font('Helvetica').fillColor(C.body).text(pdfText(detail), { width, lineGap: 1.5 })
    doc.y = Math.max(doc.y, top + h) + 3
  }
  const panel = (opts: { title?: string; text: string; tint: string; edge: string; titleColor: string; textColor?: string }) => {
    const inner = W - 30
    doc.font('Helvetica').fontSize(9)
    const titleH = opts.title ? 18 : 0
    const bodyH = doc.heightOfString(pdfText(opts.text), { width: inner, lineGap: 2 })
    const h = titleH + bodyH + 22
    ensure(h)
    const top = doc.y
    doc.rect(M, top, W, h).fill(opts.tint)
    doc.rect(M, top, 4, h).fill(opts.edge)
    let y = top + 11
    if (opts.title) {
      doc.font('Helvetica-Bold').fontSize(10).fillColor(opts.titleColor).text(pdfText(opts.title), M + 18, y, { width: inner })
      y += titleH
    }
    doc.font('Helvetica').fontSize(9).fillColor(opts.textColor ?? C.body).text(pdfText(opts.text), M + 18, y, { width: inner, lineGap: 2 })
    doc.y = top + h + 12
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 1
  // ═══════════════════════════════════════════════════════════════════════
  header()
  doc.font('Helvetica-Bold').fontSize(21).fillColor(C.ink).text('Product Data Page (PDP) Enrichment Report', M, doc.y, { width: W })
  doc.y += 4
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(C.red)
    .text(pdfText(`Before & After Comparison — ${e.industryLabel}`), M, doc.y, { width: W })
  doc.y += 12
  para(e.introParagraph, { size: 9.4, gap: 14 })

  {
    const labelW = 150
    const rows: Array<[string, string]> = [
      ['Product Category', e.categoryPath.join(' > ')],
      [
        'Source (Before)',
        `${input.companyName} — ${input.enrichment.source.productName}${input.enrichment.source.sku ? ` (SKU: ${input.enrichment.source.sku})` : ''}`,
      ],
      [
        'Enriched (After)',
        `AltiusNxt — ${e.enrichedTitle}${
          [e.manufacturerPartNumber ? `Mfr Part Number: ${e.manufacturerPartNumber}` : null, e.unspsc ? `UNSPSC: ${e.unspsc}` : null]
            .filter(Boolean)
            .join(' | ')
            .replace(/^(.+)$/, ' ($1)')
        }`,
      ],
      ['Prepared For', input.preparedFor],
      ['Prepared By', `${input.preparedBy.name}${input.preparedBy.role ? `, ${input.preparedBy.role}` : ''}, ${input.preparedBy.company}`],
      ['Audit Date', date],
    ]
    for (const [label, value] of rows) {
      doc.font('Helvetica').fontSize(9.2)
      const h = Math.max(doc.heightOfString(pdfText(value), { width: W - labelW - 24 }), 11) + 16
      const top = doc.y
      doc.rect(M, top, labelW, h).fill(C.labelBg)
      doc.rect(M, top, W, h).lineWidth(0.6).strokeColor(C.rule).stroke()
      doc.moveTo(M + labelW, top).lineTo(M + labelW, top + h).strokeColor(C.rule).stroke()
      doc.font('Helvetica-Bold').fontSize(9.2).fillColor(C.ink).text(label, M + 12, top + 8, { width: labelW - 20 })
      doc.font('Helvetica').fontSize(9.2).fillColor(C.body).text(pdfText(value), M + labelW + 12, top + 8, { width: W - labelW - 24 })
      doc.y = top + h
    }
    doc.y += 16
  }
  panel({
    title: 'Strategic Executive Summary:',
    text: e.executiveSummary,
    tint: C.panelBlue,
    edge: C.blue,
    titleColor: C.blueText,
  })

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 2 — Case study
  // ═══════════════════════════════════════════════════════════════════════
  newPage()
  eyebrow('Case Study 01')
  doc.font('Helvetica-Bold').fontSize(17).fillColor(C.ink).text(pdfText(e.enrichedTitle), M, doc.y, { width: W })
  doc.y += 4
  doc
    .font('Helvetica-Bold')
    .fontSize(9.2)
    .fillColor(C.blue)
    .text(pdfText(e.categoryPath.join(' > ')).toUpperCase(), M, doc.y, { width: W, characterSpacing: 0.4 })
  doc.y += 10
  {
    const colW = W / 2
    const pad = 12
    const headH = 38
    const top = doc.y
    doc.rect(M, top, colW, headH).fill(C.slate)
    doc.rect(M + colW, top, colW, headH).fill(C.red)
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor('#ffffff')
      .text('ORIGINAL PRODUCT LISTING', M, top + 8, { width: colW, align: 'center' })
      .text(pdfText(`(BEFORE – ${input.companyName.toUpperCase()})`), M, top + 21, { width: colW, align: 'center' })
    doc
      .font('Helvetica-Bold')
      .fontSize(9.5)
      .fillColor('#ffffff')
      .text('ENRICHED PRODUCT RECORD', M + colW, top + 8, { width: colW, align: 'center' })
      .text('(AFTER – ALTIUSNXT)', M + colW, top + 21, { width: colW, align: 'center' })
    const bodyTop = top + headH
    const before = e.beforeNarrative.map(pdfText).join('\n\n')
    const after = e.afterNarrative.map(pdfText).join('\n\n')
    doc.font('Helvetica').fontSize(8.8)
    const h = Math.max(
      doc.heightOfString(before, { width: colW - pad * 2, lineGap: 1.6 }),
      doc.heightOfString(after, { width: colW - pad * 2, lineGap: 1.6 }),
    ) + pad * 2
    doc.rect(M, bodyTop, colW, h).fill('#f8fafc')
    doc.rect(M, bodyTop, W, h).lineWidth(0.6).strokeColor(C.rule).stroke()
    doc.moveTo(M + colW, bodyTop).lineTo(M + colW, bodyTop + h).strokeColor(C.rule).stroke()
    doc.fillColor(C.body).text(before, M + pad, bodyTop + pad, { width: colW - pad * 2, lineGap: 1.6 })
    doc.fillColor(C.body).text(after, M + colW + pad, bodyTop + pad, { width: colW - pad * 2, lineGap: 1.6 })
    doc.y = bodyTop + h + 12
  }
  panel({
    text: `KEY TRANSFORMATION: ${e.keyTransformation}`,
    tint: C.panelGreen,
    edge: C.green,
    titleColor: C.green,
    textColor: C.green,
  })
  heading('KEY ENRICHED ATTRIBUTES CAPTURED', 11)
  doc.y += 2
  for (const h of e.attributeHighlights) leadBullet(h.heading, h.detail, '•')

  // ═══════════════════════════════════════════════════════════════════════
  // PAGES 3 & 4 — the two pages, photographed
  // ═══════════════════════════════════════════════════════════════════════
  const capturePage = (title: string, caption: string, bytes: Buffer | null, missing: string) => {
    newPage()
    doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text(pdfText(title), M, doc.y, { width: W })
    doc.y += 3
    doc.font('Helvetica').fontSize(9).fillColor(C.muted).text(pdfText(caption), M, doc.y, { width: W })
    doc.y += 10
    const frameTop = doc.y
    const frameH = BOTTOM - frameTop - 6
    doc.roundedRect(M, frameTop, W, frameH, 4).lineWidth(0.8).strokeColor('#cbd5e1').stroke()
    const img = image(bytes)
    if (img) {
      const scale = Math.min((W - 20) / img.width, (frameH - 20) / img.height)
      const w = img.width * scale
      const h = img.height * scale
      doc.image(img as never, M + (W - w) / 2, frameTop + 10, { width: w, height: h })
    } else {
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(C.muted)
        .text(pdfText(missing), M + 30, frameTop + frameH / 2 - 20, { width: W - 60, align: 'center' })
    }
  }
  capturePage(
    `Original Product Page (${input.companyName.toUpperCase()})`,
    `Source page capture: ${input.companyName} — ${input.enrichment.source.productName}${
      input.enrichment.source.sku ? ` (SKU: ${input.enrichment.source.sku})` : ''
    }. ${input.sourceUrl}`,
    input.beforeCapture,
    `No capture of the original page is available. ${input.captureNote ?? ''} The page audited is ${input.sourceUrl}.`,
  )
  capturePage(
    'Enriched Result (AltiusNxt)',
    `${e.enrichedTitle} — Fully Normalized B2B Product Master`,
    input.afterCapture,
    `No capture of the enriched page is available. ${input.captureNote ?? ''}`,
  )

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 5 — the matrix
  // ═══════════════════════════════════════════════════════════════════════
  newPage()
  doc.font('Helvetica-Bold').fontSize(13).fillColor(C.ink).text('Full Technical Specification Matrix', M, doc.y, { width: W })
  doc.y += 3
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(C.muted)
    .text('Complete normalized attribute schema extracted, validated, and mapped into the AltiusNxt Product Information Management (PIM) taxonomy:', M, doc.y, { width: W })
  doc.y += 10
  drawMatrix(doc, e.attributes, ensure)
  const enrichedCount = e.attributes.filter((a) => a.source === 'enriched').length
  if (enrichedCount) {
    ensure(20)
    doc
      .font('Helvetica')
      .fontSize(7.6)
      .fillColor(C.violet)
      .text(
        `* AI-enriched value (${enrichedCount} of ${e.attributes.length} attributes): proposed for this product type and to be confirmed against manufacturer data before publication. Unmarked values were found on the customer's page${
          e.attributes.some((a) => a.source === 'manufacturer') ? ' or a manufacturer page' : ''
        }.`,
        M,
        doc.y,
        { width: W },
      )
    doc.y += 12
  }
  {
    const notes = e.normalizationNotes
    const inner = W - 36
    doc.font('Helvetica').fontSize(8.6)
    const h =
      notes.reduce((sum, n) => sum + doc.heightOfString(`${pdfText(n.heading)}: ${pdfText(n.detail)}`, { width: inner }) + 6, 0) + 36
    ensure(h)
    const top = doc.y
    doc.roundedRect(M, top, W, h, 4).fillAndStroke('#f8fafc', '#cbd5e1')
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text('STANDARDIZATION & NORMALIZATION NOTES', M + 14, top + 12, { width: inner })
    doc.y = top + 30
    for (const n of notes) {
      const y = doc.y
      doc.font('Helvetica').fontSize(8.6).fillColor(C.ink).text('•', M + 16, y, { lineBreak: false })
      doc.font('Helvetica-Bold').fontSize(8.6).fillColor(C.ink).text(`${pdfText(n.heading)}: `, M + 24, y, { width: inner - 8, continued: true })
      doc.font('Helvetica').fillColor(C.body).text(pdfText(n.detail), { width: inner - 8 })
      doc.y += 5
    }
    doc.y = top + h + 10
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE 6 — summary, next steps, sign-off
  // ═══════════════════════════════════════════════════════════════════════
  newPage()
  eyebrow('Summary & Next Steps')
  heading('Catalog Enrichment Audit Summary', 13)
  para(e.auditSummary, { gap: 12 })
  heading('Key Improvements Demonstrated', 13)
  for (const k of e.keyImprovements) leadBullet(k.heading, k.detail, '•')
  doc.y += 8
  heading(`Recommended Next Steps for ${company}`, 13)
  para(
    `To scale this transformation across ${input.companyName}'s catalogue, AltiusNxt recommends an end-to-end automated and expert-assisted catalog enrichment program:`,
    { gap: 6 },
  )
  e.nextSteps.forEach((s, i) => leadBullet(s.heading, s.detail, `${i + 1}.`))

  {
    ensure(120)
    doc.y += 10
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.8).strokeColor(C.rule).stroke()
    doc.y += 14
    const top = doc.y
    doc.font('Helvetica').fontSize(9).fillColor(C.muted).text('PREPARED BY', M, top, { characterSpacing: 0.8 })
    doc.font('Helvetica-Bold').fontSize(12).fillColor(C.blue).text(pdfText(input.preparedBy.name), M, top + 16)
    let y = top + 33
    if (input.preparedBy.role) {
      doc.font('Helvetica').fontSize(9.5).fillColor(C.ink).text(pdfText(input.preparedBy.role), M, y)
      y += 14
    }
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(C.ink).text(pdfText(input.preparedBy.company), M, y)
    y += 16
    const contact = [
      input.preparedBy.phone ? `m: ${input.preparedBy.phone}` : null,
      input.preparedBy.email ? `e: ${input.preparedBy.email}` : null,
      input.preparedBy.web ? `w: ${input.preparedBy.web}` : null,
    ]
      .filter(Boolean)
      .join('  |  ')
    if (contact) doc.font('Helvetica').fontSize(8.6).fillColor(C.muted).text(pdfText(contact), M, y)

    if (input.shareUrl) {
      const qr = await QRCode.toBuffer(input.shareUrl, { margin: 1, width: 180 })
      const q = image(qr)
      if (q) {
        doc.image(q as never, M + W - 150, top - 4, { width: 66 })
        doc.font('Helvetica').fontSize(7).fillColor(C.muted).text('Scan to view the enriched page', M + W - 170, top + 64, { width: 106, align: 'center' })
      }
    }
    if (logo) {
      doc.image(logo as never, M + W - 70, top + 10, { height: 22 })
      doc.rect(M + W - 70, top + 38, 70, 1.6).fill(C.red)
    }
  }

  // ── Footers ────────────────────────────────────────────────────────────
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    const restore = doc.page.margins.bottom
    doc.page.margins.bottom = 0
    doc.font('Helvetica').fontSize(8.5).fillColor(C.muted)
    doc.text(pdfText(`AltiusNxt | Prepared for ${input.preparedFor}`), M, PAGE_H - 40, { width: W * 0.7, lineBreak: false })
    doc.text(`Page ${i + 1}`, M, PAGE_H - 40, { width: W, align: 'right', lineBreak: false })
    if (input.watermark) {
      doc.rect(M, 12, W, 13).fill('#fdecec')
      doc
        .font('Helvetica-Bold')
        .fontSize(7)
        .fillColor(C.red)
        .text(pdfText(input.watermark).toUpperCase(), M + 8, 15.5, { width: W - 16, align: 'center', lineBreak: false })
    }
    doc.page.margins.bottom = restore
  }
  const pageCount = doc.bufferedPageRange().count

  doc.end()
  await done
  const bytes = Buffer.concat(chunks)
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), pageCount }
}

/**
 * The four-column matrix: label | value | label | value. A value too long for
 * half a row takes a full-width row of its own, as the template does.
 */
function drawMatrix(doc: Doc, attributes: EnrichedAttribute[], ensure: (h: number) => void): void {
  const labelW = W * 0.215
  const valueW = W * 0.285
  const fullValueW = W - labelW
  // A long record is set tighter so the matrix and its notes share one page,
  // as the template's does.
  const size = attributes.length > 26 ? 8.1 : 8.6
  const pad = attributes.length > 26 ? 9 : 13
  const val = (a: EnrichedAttribute) => `${pdfText(a.value)}${a.source === 'enriched' ? ' *' : ''}`
  const isLong = (a: EnrichedAttribute) => {
    doc.font('Helvetica').fontSize(size)
    return doc.widthOfString(val(a)) > valueW * 1.9
  }

  /** Labels are drawn bold, so they are measured bold. */
  const nameHeight = (name: string) => {
    doc.font('Helvetica-Bold').fontSize(size)
    const h = doc.heightOfString(pdfText(name), { width: labelW - 16 })
    doc.font('Helvetica').fontSize(size)
    return h
  }

  const shortOnes = attributes.filter((a) => !isLong(a))
  const longOnes = attributes.filter((a) => isLong(a))
  const rows: Array<[EnrichedAttribute, EnrichedAttribute | null] | [EnrichedAttribute]> = []
  for (let i = 0; i < shortOnes.length; i += 2) rows.push([shortOnes[i]!, shortOnes[i + 1] ?? null])
  for (const a of longOnes) rows.push([a])

  const cell = (text: string, x: number, y: number, w: number, h: number, bold: boolean, bg: string | null, enriched = false) => {
    if (bg) doc.rect(x, y, w, h).fill(bg)
    doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(C.rule).stroke()
    doc
      .font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(size)
      .fillColor(enriched ? C.body : bold ? C.ink : C.body)
      .text(text, x + 8, y + pad / 2, { width: w - 16, lineGap: 1 })
  }

  for (const row of rows) {
    doc.font('Helvetica').fontSize(size)
    if (row.length === 1) {
      const a = row[0]
      const h = Math.max(doc.heightOfString(val(a), { width: fullValueW - 16 }), nameHeight(a.name)) + pad
      ensure(h)
      const y = doc.y
      cell(pdfText(a.name), M, y, labelW, h, true, C.labelBg)
      cell(val(a), M + labelW, y, fullValueW, h, false, null, a.source === 'enriched')
      doc.y = y + h
      continue
    }
    const [a, b] = row
    const h =
      Math.max(
        nameHeight(a.name),
        doc.heightOfString(val(a), { width: valueW - 16 }),
        b ? nameHeight(b.name) : 0,
        b ? doc.heightOfString(val(b), { width: valueW - 16 }) : 0,
      ) + pad
    ensure(h)
    const y = doc.y
    cell(pdfText(a.name), M, y, labelW, h, true, C.labelBg)
    cell(val(a), M + labelW, y, valueW, h, false, null, a.source === 'enriched')
    if (b) {
      cell(pdfText(b.name), M + labelW + valueW, y, labelW, h, true, C.labelBg)
      cell(val(b), M + labelW * 2 + valueW, y, valueW, h, false, null, b.source === 'enriched')
    } else {
      doc.rect(M + labelW + valueW, y, labelW + valueW, h).lineWidth(0.5).strokeColor(C.rule).stroke()
    }
    doc.y = y + h
  }
  doc.y += 8
}
