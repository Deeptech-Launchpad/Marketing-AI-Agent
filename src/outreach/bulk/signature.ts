import sanitizeHtml from 'sanitize-html'

// THE BULK EMAIL SIGNATURE, AS PASTED (2026-10-08).
//
// The user pastes their signature — from Gmail, Outlook or a web page — and it
// goes into every email exactly as it looks: the same lines, spacing, fonts,
// colours, table layout, links and images. Nothing is rewritten or shortened.
// Only what could run code or cannot travel in an email is taken out, and the
// screen says so:
//
//   - scripts, event handlers (onclick …), javascript: links, forms, frames;
//   - images that live on the user's own computer (file:, blob:) — they do
//     not exist for the recipient; an image added with "Insert image" or
//     pasted as a picture is embedded instead (data: → an inline attachment).

/** The whole signature, embedded images included. */
export const MAX_SIGNATURE_HTML = 1_500_000
/** One embedded image. */
export const MAX_IMAGE_BYTES = 400_000

const DATA_IMAGE = /^data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/i

// CSS that could load or run something is removed; every other declaration
// (font, colour, size, spacing, borders, alignment …) is kept as pasted.
const BAD_CSS = /expression\s*\(|javascript\s*:|vbscript\s*:|behavior\s*:|-moz-binding|@import|url\s*\(\s*['"]?\s*(?!https:)/i

function cleanStyle(style: string): string {
  return style
    .split(';')
    .filter((d) => d.trim() && !BAD_CSS.test(d))
    .join(';')
}

export interface CleanSignature {
  html: string
  /** The same signature as plain text, for the plain-text part of the email. */
  text: string
  /** What was taken out, in words (empty when the signature was kept whole). */
  removed: string[]
}

const STYLE_ATTRS = ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'dir', 'title', 'lang']

export function cleanSignatureHtml(input: string): CleanSignature {
  const removed = new Set<string>()
  const html = sanitizeHtml(input ?? '', {
    allowedTags: [
      'div', 'p', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'small', 'big', 'sub', 'sup', 'font', 'center',
      'a', 'img', 'hr', 'blockquote', 'pre', 'code',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'col', 'colgroup',
      'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ],
    allowedAttributes: {
      '*': STYLE_ATTRS,
      a: [...STYLE_ATTRS, 'href', 'target', 'name'],
      img: [...STYLE_ATTRS, 'src', 'alt', 'border', 'hspace', 'vspace'],
      table: [...STYLE_ATTRS, 'border', 'cellpadding', 'cellspacing', 'role', 'background'],
      td: [...STYLE_ATTRS, 'colspan', 'rowspan', 'nowrap'],
      th: [...STYLE_ATTRS, 'colspan', 'rowspan', 'nowrap'],
      col: [...STYLE_ATTRS, 'span'],
      font: [...STYLE_ATTRS, 'color', 'face', 'size'],
      hr: [...STYLE_ATTRS, 'size', 'noshade', 'color'],
      ol: [...STYLE_ATTRS, 'start', 'type'],
      ul: [...STYLE_ATTRS, 'type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    allowedSchemesByTag: { img: ['http', 'https', 'data', 'cid'] },
    allowProtocolRelative: false,
    // Scripts, styles blocks and the like go with their contents.
    nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head'],
    transformTags: {
      '*': (tagName, attribs) => {
        if (attribs.style !== undefined) {
          const style = cleanStyle(attribs.style)
          if (style !== attribs.style) removed.add('style rules that load outside content')
          if (style) attribs.style = style
          else delete attribs.style
        }
        return { tagName, attribs }
      },
    },
    exclusiveFilter: (frame) => {
      if (frame.tag !== 'img') return false
      const src = (frame.attribs.src ?? '').trim()
      if (/^https?:\/\//i.test(src) || /^cid:/i.test(src)) return false
      const m = DATA_IMAGE.exec(src)
      if (m) {
        const bytes = Math.floor((m[2]!.replace(/\s/g, '').length * 3) / 4)
        if (bytes <= MAX_IMAGE_BYTES) return false
        removed.add(`an image larger than ${Math.round(MAX_IMAGE_BYTES / 1000)} KB`)
        return true
      }
      // file:, blob: and other addresses were already emptied by the allow-list.
      removed.add('an image that is not on the web, for example one saved on your computer (use "Insert image" to add it)')
      return true
    },
  })
  // Anything dropped by the allow-list (scripts, handlers, forms …).
  const plainBefore = (input ?? '').replace(/\s+/g, '')
  if (/<script|\son\w+\s*=|javascript:|<iframe|<form|<object|<embed/i.test(plainBefore)) removed.add('scripts and active content')

  const trimmed = html.trim()
  return { html: trimmed, text: signatureText(trimmed), removed: [...removed] }
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" }

/** The signature as plain text: its lines, in order, without markup. */
export function signatureText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote|pre|center)>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\n')
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `${alt} ` : ''))
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Embedded (data:) images become inline attachments, referenced by cid, so
 * mail programs show them — most do not show data: images.
 */
export function inlineImages(html: string): { html: string; attachments: Array<{ cid: string; filename: string; content: Buffer; contentType: string; contentDisposition: 'inline' }> } {
  const attachments: Array<{ cid: string; filename: string; content: Buffer; contentType: string; contentDisposition: 'inline' }> = []
  const seen = new Map<string, string>()
  const out = html.replace(/(<img\b[^>]*?\bsrc=")(data:image\/(png|jpe?g|gif|webp);base64,([A-Za-z0-9+/=\s]+))(")/gi, (_m, pre: string, uri: string, ext: string, b64: string, post: string) => {
    let cid = seen.get(uri)
    if (!cid) {
      cid = `sig${attachments.length + 1}@altius-bulk`
      seen.set(uri, cid)
      const type = ext.toLowerCase() === 'jpg' ? 'jpeg' : ext.toLowerCase()
      attachments.push({ cid, filename: `signature-${attachments.length + 1}.${type === 'jpeg' ? 'jpg' : type}`, content: Buffer.from(b64.replace(/\s/g, ''), 'base64'), contentType: `image/${type}`, contentDisposition: 'inline' })
    }
    return `${pre}cid:${cid}${post}`
  })
  return { html: out, attachments }
}
