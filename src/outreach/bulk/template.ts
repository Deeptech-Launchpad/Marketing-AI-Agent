// THE STATIC APPROVED TEMPLATE FOR BULK EMAIL (2026-10-07).
//
// Sales supplied this text and it is used exactly as written. Nothing writes
// or rewrites it: no model is involved anywhere in bulk email. Only the two
// placeholders below are replaced, from the uploaded spreadsheet:
//
//   [First Name]   — the contact's first name
//   [Company Name] — the company's name
//
// Each line of the approved text is one paragraph; paragraphs are separated
// by a blank line in the email, which changes the layout, never the words.
// Nothing else is added — no footer, no AI text — except the signature the
// user set for the sender, under the approved text, exactly as they pasted it
// (signature.ts) (2026-10-08).

export interface BulkTemplate {
  key: string
  label: string
  subject: string
  /** The approved text, one paragraph per line. */
  body: string
}

export const STATIC_SITE: BulkTemplate = {
  key: 'static_site_v1',
  label: 'Static Site',
  subject: 'Are AI tools recommending [Company Name]?',
  body: [
    '[First Name],',
    'Manoj here, from AltiusNxt.',
    "I asked ChatGPT, Gemini, Claude and Perplexity which suppliers they would recommend for your product category. You didn't come up as a recommended supplier.",
    "The likely reason is that your website explains what you do well, but it doesn't show each part with its own details such as specs and datasheets. AI tools have little to quote, so buyers get pointed to other suppliers.",
    'We help distributors fix this. We build an online parts catalog where every part has its own page and a Request-a-Quote option, so each inquiry arrives with the part number and quantity. We have done this for 20+ years for companies like Vallen, Travers Tool Co and Rubix Group.',
    'We will also be at B2B eCommerce World in Indianapolis on Nov 2-3, and I can invite you as our guest - register here with code ALTIUSVIP.',
    'I have a short report showing what each AI tool said. Would you like me to send it?',
  ].join('\n'),
}

export const BULK_TEMPLATES: BulkTemplate[] = [STATIC_SITE]

export function bulkTemplate(key: string): BulkTemplate | null {
  return BULK_TEMPLATES.find((t) => t.key === key) ?? null
}

/** The words in the approved text that link to the expo registration page, in the HTML part only. */
const REGISTER_WORDS = 'register here'
/** B2B eCommerce World 2026, Indianapolis — the guest registration with code ALTIUSVIP. */
export const EXPO_REGISTRATION_URL =
  'https://events.b2becommerceworld.org/v2/registrations/event/696f763a5e592e8a0a92da6e/ticketType/6971a5671dfa01967fe37b30?couponCode=ALTIUSVIP'

const PLACEHOLDER = /\[(First Name|Company Name)\]/g

/** The template with only its placeholders filled. Anything left unfilled is listed. */
export function fillTemplate(text: string, values: { firstName: string | null; companyName: string | null }): { text: string; unfilled: string[] } {
  const unfilled: string[] = []
  const out = text.replace(PLACEHOLDER, (token, name: string) => {
    const v = name === 'First Name' ? values.firstName : values.companyName
    if (!v || !v.trim()) {
      unfilled.push(token)
      return token
    }
    return v.trim()
  })
  return { text: out, unfilled }
}

export interface ComposedBulkEmail {
  subject: string
  text: string
  html: string
  unfilled: string[]
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The user's signature as it is sent: its own line breaks, no control characters, at most 1000 characters. */
export function cleanSignature(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim()
    .slice(0, 1000)
}

/**
 * The email exactly as it is sent: the approved template with its two
 * placeholders filled and, under it, the sender's signature if one is set.
 */
export function composeBulkEmail(input: {
  template: BulkTemplate
  firstName: string | null
  companyName: string | null
  /** The signature as plain text (the text part of the email). */
  signature?: string | null
  /** The signature as pasted (already cleaned) — used as is in the HTML part. */
  signatureHtml?: string | null
}): ComposedBulkEmail {
  const subject = fillTemplate(input.template.subject, input)
  const body = fillTemplate(input.template.body, input)
  const paragraphs = body.text.split('\n').map((p) => p.trim()).filter(Boolean)
  const signature = cleanSignature(input.signature)
  const text = paragraphs.join('\n\n') + (signature ? `\n\n${signature}` : '')

  const para = (p: string) => {
    const safe = escapeHtml(p)
    return safe.includes(REGISTER_WORDS)
      ? safe.replace(REGISTER_WORDS, `<a href="${escapeHtml(EXPO_REGISTRATION_URL)}">${REGISTER_WORDS}</a>`)
      : safe
  }
  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222">',
    ...paragraphs.map((p) => `<p style="margin:0 0 12px">${para(p)}</p>`),
    ...(input.signatureHtml?.trim()
      ? [`<div>${input.signatureHtml}</div>`]
      : signature
        ? [`<p style="margin:0 0 12px">${signature.split('\n').map(escapeHtml).join('<br>')}</p>`]
        : []),
    '</div>',
  ].join('')

  return { subject: subject.text, text, html, unfilled: [...new Set([...subject.unfilled, ...body.unfilled])] }
}
