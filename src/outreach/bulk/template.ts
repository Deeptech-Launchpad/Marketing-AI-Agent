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

// Versions 2 and 3 (approved 2026-10-08), exactly as Sales supplied them.
export const STATIC_SITE_V2: BulkTemplate = {
  key: 'static_site_v2',
  label: 'Static Site — Version 2',
  subject: 'What AI LLMs say about [Company Name]',
  body: [
    '[First Name],',
    'This is Manoj from AltiusNxt.',
    "I asked ChatGPT, Gemini, Claude and Perplexity which suppliers they would recommend for your product category. You didn't come up as a recommended supplier.",
    "One likely reason: your range and services are described well on your site, but there are no pages for individual parts with specs and datasheets. That leaves AI tools with little to quote, so buyers end up on competitors' listings.",
    'We fix this for distributors with an online parts catalog, part-level Request-a-Quote and product details built from manufacturer sources. Our clients include Vallen, Travers Tool Co and Rubix Group, and we have worked in this area for 20+ years.',
    'We are also attending B2B eCommerce World in Indianapolis on Nov 2-3, and you are welcome to join us as our guest - register here with code ALTIUSVIP.',
    'I put together a short report on what the AI tools returned for you. Shall I send it over?',
  ].join('\n'),
}

export const STATIC_SITE_V3: BulkTemplate = {
  key: 'static_site_v3',
  label: 'Static Site — Version 3',
  subject: 'Quick note on AI search for [Company Name]',
  body: [
    '[First Name],',
    'Manoj from AltiusNxt here.',
    "I asked ChatGPT, Gemini, Claude and Perplexity which suppliers they would recommend for your product category. You didn't come up as a recommended supplier.",
    "My guess is that your website talks about your strengths, but each part doesn't have its own page with details like specs and datasheets. Without these, AI tools have little to point to, and buyers go to other suppliers.",
    'For 20+ years we have helped distributors, including Vallen, Travers Tool Co and Rubix Group, with an online parts catalog, part-level Request-a-Quote and well-structured product data.',
    'If you will be in Indianapolis on Nov 2-3 for B2B eCommerce World, we would be glad to host you as our guest - register here with the code ALTIUSVIP.',
    'I can send you a short report on what each AI tool returned. Just let me know, and I will send it over.',
  ].join('\n'),
}

/**
 * The approved versions, in rotation order: the 1st email of a bulk list gets
 * Version 1, the 2nd Version 2, the 3rd Version 3, the 4th Version 1 again …
 * Only which version a person gets is chosen — never the words.
 */
export const BULK_ROTATION: BulkTemplate[] = [STATIC_SITE, STATIC_SITE_V2, STATIC_SITE_V3]
export const BULK_TEMPLATES: BulkTemplate[] = BULK_ROTATION

/** The version for the n-th email of a list (0-based). */
export function rotationTemplate(n: number): BulkTemplate {
  return BULK_ROTATION[n % BULK_ROTATION.length]!
}

/** 1, 2 or 3. */
export function versionOf(key: string | null | undefined): number | null {
  const i = BULK_ROTATION.findIndex((t) => t.key === key)
  return i < 0 ? null : i + 1
}

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

/** One empty line, as mail programs write it. */
export const SIGNATURE_GAP = '<div><br></div>'

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
    '<div style="font-family:Verdana,Geneva,sans-serif;font-size:14px;line-height:1.5;color:#222">',
    ...paragraphs.map((p) => `<p style="margin:0 0 12px">${para(p)}</p>`),
    // A blank line between the last sentence and the signature, so the
    // signature never sits right under the text (2026-10-08).
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
