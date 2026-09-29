// THE PLACEHOLDERS IN THE APPROVED COPY — AND NOTHING ELSE.
//
// The list is explicit on purpose. The approved copy also contains bracketed
// text that is not a placeholder, and a generic "anything in [ ]" rule would
// either flag real copy as unfilled or, worse, let a real placeholder through
// as if it were copy. A token not on this list is never touched.

export const PLACEHOLDERS = {
  name: '[Name]',
  company: '[Company]',
  product: '[Product]',
  productCategory: '[product category]',
  companyOrProduct: '[Company / Product]',
  clientCompanyName: '[Client Company Name]',
  sku1: '[1st SKU name]',
  sku2: '[2nd SKU name]',
  sku3: '[3rd SKU name]',
  sku4: '[4th SKU name]',
  sku5: '[5th SKU name]',
  xOf5Recommended: '[X of 5 went from not recommended to appearing in the AI answer]',
  xOf5NotRecommended: '[X of 5 were not recommended by any of the four engines]',
  senderFirstName: '[Sender first name]',
  senderCompany: '[Sender company]',
  /** The genuine product page Prospects verified for THIS company (compose.ts). */
  productPageUrl: '[Product page URL]',
} as const

export type PlaceholderKey = keyof typeof PLACEHOLDERS
export type PlaceholderValues = Partial<Record<PlaceholderKey, string | null>>

const ALL = Object.entries(PLACEHOLDERS) as Array<[PlaceholderKey, string]>

/** Which placeholders a piece of approved copy uses. */
export function placeholdersIn(text: string | null): PlaceholderKey[] {
  if (!text) return []
  return ALL.filter(([, token]) => text.includes(token)).map(([key]) => key)
}

/**
 * Replaces every placeholder that has a value. One with no value stays in the
 * text, visible, exactly as the approved copy wrote it — it is never replaced
 * with a guess or a blank.
 */
export function fill(text: string, values: PlaceholderValues): string {
  let out = text
  for (const [key, token] of ALL) {
    const value = values[key]
    if (typeof value === 'string' && value.trim()) out = out.split(token).join(value.trim())
  }
  return out
}

/** The placeholders still present in a draft. Only the explicit list counts. */
export function findUnresolved(text: string | null): PlaceholderKey[] {
  return placeholdersIn(text)
}

/** The human label of a placeholder, as the approved copy writes it. */
export function tokenOf(key: PlaceholderKey): string {
  return PLACEHOLDERS[key]
}

const HONORIFICS = /^(mr|mrs|ms|miss|mx|dr|prof|sir|madam)\.?$/i

/**
 * The first name a greeting uses, from a verified full name.
 *
 * Only ever a word of the name itself: an honorific is skipped, a quoted
 * nickname is ignored, and an empty result is null — the greeting then stays
 * "[Name]" for Sales to fill, rather than becoming "Hi there".
 */
export function firstName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const words = fullName
    .replace(/["“”'‘’(][^"“”'‘’)]*["“”'‘’)]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean)
  const first = words.find((w) => !HONORIFICS.test(w))
  if (!first) return null
  const clean = first.replace(/[,;:]+$/, '')
  return /[a-z]/i.test(clean) ? clean : null
}

const LEGAL_SUFFIX = /[,\s]+(inc\.?|incorporated|llc|l\.l\.c\.|ltd\.?|limited|corp\.?|corporation|co\.?|plc|gmbh|pty\.?\s*ltd\.?|lp|llp)$/i

/**
 * The company name as an email would write it: the verified name with a
 * trailing legal form removed ("Radians, Inc." → "Radians"). Nothing else is
 * changed, and a name that would become empty is returned as it was.
 */
export function companyDisplayName(name: string | null | undefined): string | null {
  if (!name?.trim()) return null
  let n = name.trim()
  for (let i = 0; i < 2; i++) {
    const next = n.replace(LEGAL_SUFFIX, '').trim()
    if (!next || next === n) break
    n = next
  }
  return n
}
