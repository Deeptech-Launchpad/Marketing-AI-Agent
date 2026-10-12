import sanitizeHtml from 'sanitize-html'
import { BadRequestError } from '../../platform/errors.js'
import { cleanStyle, signatureText, STYLE_ATTRS } from './signature.js'
import { cleanSignature, fillTemplate, SIGNATURE_GAP, type ComposedBulkEmail } from './template.js'

// "USE MY OWN TEMPLATE" (2026-10-12).
//
// Instead of the approved Versions 1, 2 and 3, the user pastes their own email
// (a subject and a body, formatted or plain). It is cleaned once, here, on the
// server — the browser's own clean-up is never trusted — then every recipient
// gets that SAME email with only [First Name] and [Company Name] filled in.
// What was reviewed is stored per recipient and sent as it is.
//
// Only what could run code or cannot travel in an email is taken out (the same
// rules as the pasted signature): scripts, event handlers, javascript: links,
// forms, frames, and images that are not on the web (a pasted picture is a
// data: image and is removed — use a link to an image on the web instead).

export const CUSTOM_TEMPLATE_KEY = 'custom'
export const MAX_CUSTOM_SUBJECT = 200
/** The pasted email, as HTML. */
export const MAX_CUSTOM_HTML = 200_000

export interface CustomTemplate {
  subject: string
  /** The cleaned body, still with its [First Name] / [Company Name] placeholders. */
  html: string
  /** The same body as plain text (the text part of the email), still with its placeholders. */
  text: string
  /** What was taken out, in words (empty when the email was kept whole). */
  removed: string[]
}

const PLACEHOLDER = /\[(First Name|Company Name)\]/g
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The email as plain text (the text part): one blank line between paragraphs, as in the approved versions. */
function textOf(html: string): string {
  return signatureText(html.replace(/<\/(p|h[1-6]|ul|ol|blockquote|table)>/gi, (m) => `${m}<br>`))
}

/** The pasted email's HTML, cleaned. Pure. */
export function cleanTemplateHtml(input: string): { html: string; removed: string[] } {
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
      a: [...STYLE_ATTRS, 'href', 'name'],
      img: [...STYLE_ATTRS, 'src', 'alt', 'border'],
      table: [...STYLE_ATTRS, 'border', 'cellpadding', 'cellspacing', 'role'],
      td: [...STYLE_ATTRS, 'colspan', 'rowspan', 'nowrap'],
      th: [...STYLE_ATTRS, 'colspan', 'rowspan', 'nowrap'],
      col: [...STYLE_ATTRS, 'span'],
      font: [...STYLE_ATTRS, 'color', 'face', 'size'],
      hr: [...STYLE_ATTRS, 'size', 'noshade', 'color'],
      ol: [...STYLE_ATTRS, 'start', 'type'],
      ul: [...STYLE_ATTRS, 'type'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    // Images only from the web, over https.
    allowedSchemesByTag: { img: ['https'] },
    allowProtocolRelative: false,
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
      if (/^https:\/\//i.test((frame.attribs.src ?? '').trim())) return false
      removed.add('an image that is not a link to the web (a pasted or saved picture cannot be used - add it as a link to an image on the web)')
      return true
    },
  })
  const compact = (input ?? '').replace(/\s+/g, '')
  if (/<script|\son\w+\s*=|javascript:|<iframe|<form|<object|<embed/i.test(compact)) removed.add('scripts and active content')
  return { html: html.trim(), removed: [...removed] }
}

/** Validates and cleans what the user pasted. Throws a sentence a person can act on. */
export function prepareCustomTemplate(input: { subject: string; bodyHtml: string }): CustomTemplate {
  const subject = String(input.subject ?? '').trim()
  if (!subject) throw new BadRequestError('Enter the subject of your template.')
  if (/[\r\n]/.test(subject)) throw new BadRequestError('The subject must be one line.')
  if (subject.length > MAX_CUSTOM_SUBJECT) throw new BadRequestError(`The subject is longer than ${MAX_CUSTOM_SUBJECT} characters.`)
  const raw = String(input.bodyHtml ?? '')
  if (raw.length > MAX_CUSTOM_HTML) throw new BadRequestError('The template is too long. Shorten it and try again.')
  const cleaned = cleanTemplateHtml(raw)
  const text = textOf(cleaned.html)
  if (!text) throw new BadRequestError('Paste the body of your template.')
  return { subject, html: cleaned.html, text, removed: cleaned.removed }
}

/** The tokens left in a template once it is filled for one person (blank values stay as typed and are listed). */
function fillHtml(html: string, values: { firstName: string | null; companyName: string | null }): { html: string; unfilled: string[] } {
  const unfilled: string[] = []
  const out = html.replace(PLACEHOLDER, (token, name: string) => {
    const v = name === 'First Name' ? values.firstName : values.companyName
    if (!v || !v.trim()) {
      unfilled.push(token)
      return token
    }
    return escapeHtml(v.trim())
  })
  return { html: out, unfilled }
}

/**
 * The email exactly as it is sent for one person: the user's own template
 * with only its two placeholders filled and, under it, the sender's signature
 * if one is set (empty through NXT Sales, which adds the Gmail signature).
 */
export function composeCustomEmail(input: {
  template: CustomTemplate
  firstName: string | null
  companyName: string | null
  signature?: string | null
  signatureHtml?: string | null
}): ComposedBulkEmail {
  const subject = fillTemplate(input.template.subject, input)
  const body = fillHtml(input.template.html, input)
  const signature = cleanSignature(input.signature)
  const text = textOf(body.html) + (signature ? `\n\n${signature}` : '')
  const html = [
    '<div style="font-family:Verdana,Geneva,sans-serif;font-size:14px;line-height:1.5;color:#222">',
    body.html,
    ...(input.signatureHtml?.trim() || signature ? [SIGNATURE_GAP] : []),
    ...(input.signatureHtml?.trim()
      ? [`<div>${input.signatureHtml}</div>`]
      : signature
        ? [`<p style="margin:0 0 12px">${signature.split('\n').map(escapeHtml).join('<br>')}</p>`]
        : []),
    '</div>',
  ].join('')
  return { subject: subject.text, text, html, unfilled: [...new Set([...subject.unfilled, ...body.unfilled])] }
}
