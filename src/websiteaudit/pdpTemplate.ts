
// THE PDP TEMPLATE — SHARED FURNITURE.
//
// The layout vocabulary of the AI Discoverability Audit, taken from the
// approved sample report and nothing else: its palette, its rules, its band
// widths, its type sizes. It is separated from the document that uses it so
// that "what the template looks like" and "what this customer's data says"
// are two files, and a change to one cannot quietly become a change to the
// other.
//
// Nothing here knows about a company, a product, or a score.

export const PAGE = { size: 'A4' as const, margin: 34, width: 595.28, height: 841.89 }
export const W = PAGE.width - PAGE.margin * 2
/** The last y content may occupy, above the footer rule. */
export const BOTTOM = 795

/** Sampled from the approved sample report. */
export const INK = {
  navy: '#14213d',
  ink: '#111827',
  red: '#c8102e',
  green: '#1a7f37',
  blue: '#2563eb',
  amber: '#92400e',
  body: '#374151',
  muted: '#6b7280',
  faint: '#9aa3af',
  rule: '#d9dee6',
  hair: '#e8ecf2',
  panel: '#f7f9fc',
  panelRed: '#fdf3f4',
  panelGreen: '#f2fbf5',
  panelBlue: '#eef4fb',
  panelAmber: '#fdf8e7',
  white: '#ffffff',
}

export type Doc = PDFKit.PDFDocument

/** pdfkit accepts a registered image where its typings admit only a path. */
export type OpenedImage = { width: number; height: number }
export type DocWithOpenImage = Doc & { openImage(src: Buffer): OpenedImage }
export const asSrc = (img: OpenedImage): PDFKit.Mixins.ImageSrc => img as unknown as PDFKit.Mixins.ImageSrc

export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/** Markup out, so a stored description never reaches a customer as source. */
export const plain = (raw: string): string =>
  raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()

/** The path of a URL, for citing a page on a host already named above. */
export function pathOf(url: string | null | undefined): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}${u.search}`.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** Puts the cursor back at the left margin after anything that positioned it. */
export const atLeft = (doc: Doc): void => {
  doc.x = PAGE.margin
}

// ── Page furniture ────────────────────────────────────────────────────────

/**
 * The running header: logo left, section and reference right, red rule under.
 *
 * Page one carries the confidential band instead of a section name, which is
 * how the sample distinguishes the cover from the sections that follow.
 */
export function header(
  doc: Doc,
  opts: { logo: OpenedImage | null; section: string | null; reference: string; date?: string; cover?: boolean },
): void {
  const top = 30
  if (opts.logo) doc.image(asSrc(opts.logo), PAGE.margin, top - 4, { height: 20 })
  else doc.font('Helvetica-Bold').fontSize(13).fillColor(INK.navy).text('AltiusNxt', PAGE.margin, top)

  if (opts.cover) {
    const boxW = 148
    const boxX = PAGE.margin + W - boxW
    doc.rect(boxX, top - 6, boxW, 12).lineWidth(0.8).strokeColor(INK.red).stroke()
    doc
      .font('Helvetica-Bold')
      .fontSize(6.6)
      .fillColor(INK.red)
      .text('CONFIDENTIAL & PROPRIETARY', boxX, top - 2.5, { width: boxW, align: 'center', characterSpacing: 0.5 })
    doc
      .font('Helvetica-Bold')
      .fontSize(7.2)
      .fillColor(INK.ink)
      .text(`AUDIT REPORT REF: ${opts.reference}`, PAGE.margin, top + 10, { width: W, align: 'right' })
    if (opts.date) {
      doc
        .font('Helvetica')
        .fontSize(7.2)
        .fillColor(INK.body)
        .text(`DATE: ${opts.date}`, PAGE.margin, top + 20, { width: W, align: 'right' })
    }
    doc.y = top + 40
  } else {
    doc
      .font('Helvetica')
      .fontSize(7.2)
      .fillColor(INK.muted)
      .text(`Section: ${opts.section ?? ''} · Ref: ${opts.reference}`, PAGE.margin, top + 4, { width: W, align: 'right' })
    doc.y = top + 26
  }

  doc.moveTo(PAGE.margin, doc.y).lineTo(PAGE.margin + W, doc.y).lineWidth(1.1).strokeColor(INK.red).stroke()
  doc.y += 14
  atLeft(doc)
}

/** The page's own title and its red subtitle. */
export function pageTitle(doc: Doc, title: string, subtitle: string): void {
  doc.font('Helvetica-Bold').fontSize(16).fillColor(INK.navy).text(title.toUpperCase(), PAGE.margin, doc.y, { width: W })
  doc.y += 2
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(INK.red).text(subtitle, PAGE.margin, doc.y, { width: W })
  doc.y += 14
  atLeft(doc)
}

/** A section heading with the template's red bar to its left. */
export function sectionHeading(doc: Doc, text: string): void {
  const y = doc.y
  doc.rect(PAGE.margin, y, 3, 13).fill(INK.red)
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK.navy).text(text, PAGE.margin + 9, y, { width: W - 9 })
  doc.y = y + 19
  atLeft(doc)
}

/** A tinted note box with a coloured left edge. */
export function noteBox(
  doc: Doc,
  opts: { label?: string; text: string; tint?: string; edge?: string; size?: number },
): void {
  const size = opts.size ?? 7.8
  const inner = W - 22
  doc.font('Helvetica').fontSize(size)
  const label = opts.label ? `${opts.label} ` : ''
  const h = doc.heightOfString(label + opts.text, { width: inner }) + 13
  const top = doc.y
  doc.rect(PAGE.margin, top, W, h).fill(opts.tint ?? INK.panelBlue)
  doc.rect(PAGE.margin, top, 2.5, h).fill(opts.edge ?? INK.navy)
  if (opts.label) {
    doc.font('Helvetica-Bold').fontSize(size).fillColor(INK.navy).text(opts.label, PAGE.margin + 12, top + 6.5, {
      continued: true,
    })
    doc.font('Helvetica').fillColor(INK.body).text(` ${opts.text}`, { width: inner })
  } else {
    doc.font('Helvetica').fontSize(size).fillColor(INK.body).text(opts.text, PAGE.margin + 12, top + 6.5, { width: inner })
  }
  doc.y = top + h + 10
  atLeft(doc)
}

/** A small status word in its own tint — PASS, FAIL, CRITICAL FAIL. */
export function statusInk(status: string): string {
  switch (status) {
    case 'pass':
      return INK.green
    case 'partial':
      return INK.amber
    case 'not_assessed':
      return INK.muted
    default:
      return INK.red
  }
}

export function statusWord(status: string): string {
  switch (status) {
    case 'pass':
      return 'PASS'
    case 'partial':
      return 'PARTIAL'
    case 'fail':
      return 'FAIL'
    case 'critical_fail':
      return 'CRITICAL FAIL'
    default:
      return 'NOT ASSESSED'
  }
}

export interface TableColumn {
  header: string
  /** Fraction of the content width. Must sum to 1. */
  width: number
  align?: 'left' | 'right'
}

export interface TableCell {
  text: string
  bold?: boolean
  color?: string
}

/**
 * The template's table: navy header band, hairline rows, zebra tint.
 *
 * Draws only what fits above `BOTTOM` and returns how many rows it left, so a
 * customer whose catalogue produces more rows than another's cannot silently
 * add a page to a document whose page count is part of its identity.
 */
export function table(
  doc: Doc,
  columns: TableColumn[],
  rows: TableCell[][],
  opts?: { headSize?: number; bodySize?: number; zebra?: boolean },
): { drawn: number; omitted: number } {
  const headSize = opts?.headSize ?? 6.8
  const bodySize = opts?.bodySize ?? 7.6
  const widths = columns.map((c) => c.width * W)
  const headH = 15
  let y = doc.y

  doc.rect(PAGE.margin, y, W, headH).fill(INK.navy)
  let x = PAGE.margin + 7
  doc.font('Helvetica-Bold').fontSize(headSize).fillColor(INK.white)
  columns.forEach((c, i) => {
    doc.text(c.header.toUpperCase(), x, y + 4.5, {
      width: widths[i]! - 10,
      align: c.align ?? 'left',
      characterSpacing: 0.4,
      lineBreak: false,
    })
    x += widths[i]!
  })
  y += headH

  let drawn = 0
  for (const [i, row] of rows.entries()) {
    doc.font('Helvetica').fontSize(bodySize)
    const h =
      Math.max(
        ...row.map((cell, j) => doc.heightOfString(cell.text, { width: widths[j]! - 10 })),
        11,
      ) + 7
    if (y + h > BOTTOM - 10) break

    if ((opts?.zebra ?? true) && i % 2 === 1) doc.rect(PAGE.margin, y, W, h).fill(INK.panel)
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + W, y).lineWidth(0.4).strokeColor(INK.hair).stroke()

    x = PAGE.margin + 7
    row.forEach((cell, j) => {
      doc
        .font(cell.bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bodySize)
        .fillColor(cell.color ?? INK.body)
        .text(cell.text, x, y + 3.5, { width: widths[j]! - 10, align: columns[j]!.align ?? 'left' })
      x += widths[j]!
    })
    y += h
    drawn += 1
  }

  doc.moveTo(PAGE.margin, y).lineTo(PAGE.margin + W, y).lineWidth(0.6).strokeColor(INK.rule).stroke()
  doc.y = y + 9
  atLeft(doc)
  return { drawn, omitted: rows.length - drawn }
}

/** A row of equal stat tiles: a big number over a small caption. */
export function statTiles(
  doc: Doc,
  tiles: Array<{ value: string; caption: string; color?: string }>,
): void {
  if (tiles.length === 0) return
  const gap = 6
  const tileW = (W - gap * (tiles.length - 1)) / tiles.length
  const h = 40
  const top = doc.y
  tiles.forEach((t, i) => {
    const x = PAGE.margin + i * (tileW + gap)
    doc.rect(x, top, tileW, h).fill(INK.panel)
    doc
      .font('Helvetica-Bold')
      .fontSize(14)
      .fillColor(t.color ?? INK.red)
      .text(t.value, x, top + 8, { width: tileW, align: 'center', lineBreak: false })
    doc
      .font('Helvetica-Bold')
      .fontSize(6.2)
      .fillColor(INK.muted)
      .text(t.caption.toUpperCase(), x + 4, top + 27, { width: tileW - 8, align: 'center', characterSpacing: 0.4, lineBreak: false })
  })
  doc.y = top + h + 12
  atLeft(doc)
}

/** The two-column ✕ / ✓ header band the before/after pages use. */
export function beforeAfterHeads(doc: Doc, before: string, after: string): { colW: number; leftX: number; rightX: number; top: number } {
  const gap = 10
  const colW = (W - gap) / 2
  const leftX = PAGE.margin
  const rightX = PAGE.margin + colW + gap
  const top = doc.y
  const h = 15

  doc.rect(leftX, top, colW, h).fill(INK.panelRed)
  doc.font('Helvetica-Bold').fontSize(7.6).fillColor(INK.red).text(`×  ${before}`, leftX + 7, top + 4, { width: colW - 14, lineBreak: false })
  doc.rect(rightX, top, colW, h).fill(INK.panelGreen)
  tick(doc, rightX + 7, top + 5.5, INK.green)
  doc.font('Helvetica-Bold').fontSize(7.6).fillColor(INK.green).text(after, rightX + 18, top + 4, { width: colW - 25, lineBreak: false })

  doc.y = top + h
  return { colW, leftX, rightX, top: top + h }
}

/**
 * A check mark, drawn rather than typed.
 *
 * The standard-14 fonts are WinAnsi-encoded and carry no U+2713, so a literal
 * check character silently rendered as an apostrophe everywhere it appeared.
 * Two strokes cost less than embedding a font for one glyph.
 */
export function tick(doc: Doc, x: number, y: number, colour: string): void {
  doc
    .save()
    .lineWidth(1.1)
    .strokeColor(colour)
    .moveTo(x, y + 2.6)
    .lineTo(x + 2.4, y + 5)
    .lineTo(x + 7, y - 0.6)
    .stroke()
    .restore()
}

/** A small pill, used for signal chips on the wireframes. */
export function chip(doc: Doc, x: number, y: number, text: string, tone: 'ok' | 'bad' | 'warn' | 'muted'): number {
  const tint = tone === 'ok' ? INK.panelGreen : tone === 'bad' ? INK.panelRed : tone === 'warn' ? INK.panelAmber : INK.panel
  const fg = tone === 'ok' ? INK.green : tone === 'bad' ? INK.red : tone === 'warn' ? INK.amber : INK.muted
  doc.font('Helvetica-Bold').fontSize(5.9)
  const w = doc.widthOfString(text) + 10
  doc.roundedRect(x, y, w, 10, 2).fill(tint)
  doc.fillColor(fg).text(text, x + 5, y + 2.6, { lineBreak: false })
  return w + 4
}

/** The footer on every page, drawn once the page count is final. */
export function footers(doc: Doc, opts: { label: string; watermark?: string | null }): number {
  const range = doc.bufferedPageRange()
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i)
    // pdfkit paginates when text crosses the bottom margin; with the margin at
    // zero there is nothing to paginate for. Without this the footer loop turns
    // a 7-page report into a 14-page one, half of them carrying only a footer.
    const restore = doc.page.margins.bottom
    doc.page.margins.bottom = 0

    const y = 812
    doc.moveTo(PAGE.margin, y - 8).lineTo(PAGE.margin + W, y - 8).lineWidth(0.5).strokeColor(INK.hair).stroke()
    doc.font('Helvetica').fontSize(7).fillColor(INK.faint)
    doc.text(opts.label, PAGE.margin, y, { width: W * 0.75, lineBreak: false })
    doc.font('Helvetica-Bold').text(`Page ${i + 1} of ${range.count}`, PAGE.margin, y, {
      width: W,
      align: 'right',
      lineBreak: false,
    })

    if (opts.watermark) {
      doc.rect(PAGE.margin, 8, W, 13).fill(INK.panelRed)
      doc
        .font('Helvetica-Bold')
        .fontSize(6.8)
        .fillColor(INK.red)
        .text(opts.watermark.toUpperCase(), PAGE.margin + 8, 11.5, { width: W - 16, align: 'center', lineBreak: false })
    }
    doc.page.margins.bottom = restore
  }
  return doc.bufferedPageRange().count
}
