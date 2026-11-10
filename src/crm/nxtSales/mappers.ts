import type {
  CrmActivity,
  CrmCompany,
  CrmCompanyQuery,
  CrmCustomFieldDef,
  CrmDeal,
  CrmDealStats,
  CrmDropdownField,
  CrmDropdownOption,
  CrmEmailSummary,
  CrmUser,
} from '../types.js'
import { ACTIVITY_ADDRESSES_MAX, ACTIVITY_BODY_MAX, ACTIVITY_BODY_RAW_MAX, ACTIVITY_BODY_WINDOW_DAYS, ACTIVITY_UNREAD_MARKER } from '../types.js'
import type { QueryParams } from './httpClient.js'

// ALL knowledge of NXT Sales' literal response shapes is confined to this file.
// If the CRM changes, this is the only place that needs to change, and the
// contract tests in tests/ are what catch the drift.

type Raw = Record<string, unknown>

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s ? s : null
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const bool = (v: unknown): boolean => v === true || v === 'true'

const iso = (v: unknown): string => (v ? new Date(String(v)).toISOString() : new Date(0).toISOString())

/** Company.emails / phones / contactPersons / linkedProfiles are JSON arrays that may be null. */
const jsonArray = (v: unknown): string[] => {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean)
}

/**
 * Domain query -> NXT Sales wire params.
 *
 * Encoding rules taken directly from server/src/routes/companies.js:
 *  - industries  : REPEATED array param (buildQuery emits `industries[]=`)
 *  - owners / leadStatuses / countries / cmsValues / remarksValues : comma-joined
 *  - customFilters : JSON-encoded object STRING
 * Getting either of the first two wrong fails silently — the CRM returns a
 * wrong-but-plausible result set rather than an error.
 */
export function toCompanyParams(q: CrmCompanyQuery): QueryParams {
  const p: QueryParams = {}
  if (q.search) p.search = q.search
  if (q.view) p.view = q.view
  if (q.owners?.length) p.owners = q.owners.join(',')
  if (q.leadStatuses?.length) p.leadStatuses = q.leadStatuses.join(',')
  if (q.countries?.length) p.countries = q.countries.join(',')
  if (q.cmsValues?.length) p.cmsValues = q.cmsValues.join(',')
  if (q.remarksValues?.length) p.remarksValues = q.remarksValues.join(',')
  if (q.industries?.length) p.industries = q.industries // array -> repeated param
  // NXT Sales accepts only the literal strings 'yes' / 'no' (deals some / none).
  // A boolean serialises as "true"/"false", which it ignores — silently
  // returning every company, with or without deals.
  if (q.hasDeal !== undefined) p.hasDeal = q.hasDeal ? 'yes' : 'no'
  if (q.createDate) p.createDate = q.createDate
  if (q.lastActivity) p.lastActivity = q.lastActivity
  if (q.customFilters && Object.keys(q.customFilters).length) {
    p.customFilters = JSON.stringify(q.customFilters)
  }
  if (q.sort) p.sort = q.sort
  if (q.page) p.page = q.page
  if (q.limit) p.limit = q.limit
  return p
}

export function toCompany(raw: Raw): CrmCompany {
  const owner = raw.owner as Raw | undefined
  const count = raw._count as Raw | undefined
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    email: str(raw.email),
    emails: jsonArray(raw.emails),
    phone: str(raw.phone),
    domain: str(raw.domain),
    industry: str(raw.industry),
    country: str(raw.country),
    cms: str(raw.cms),
    leadStatus: str(raw.leadStatus),
    status: str(raw.status),
    remarks: str(raw.remarks),
    notes: str(raw.notes),
    endPdpUrl: str(raw.endPdpUrl),
    contactPersons: jsonArray(raw.contactPersons),
    linkedProfiles: jsonArray(raw.linkedProfiles),
    ownerId: str(raw.ownerId),
    ownerName: owner ? str(owner.name) : null,
    dealCount: num(count?.deals),
    createdAt: iso(raw.createdAt),
    updatedAt: iso(raw.updatedAt),
  }
}

export function toDeal(raw: Raw): CrmDeal {
  const company = raw.company as Raw | undefined
  return {
    id: String(raw.id),
    title: String(raw.title ?? ''),
    value: num(raw.value),
    currency: String(raw.currency ?? 'USD'),
    stage: String(raw.stage ?? ''),
    companyId: str(raw.companyId),
    companyName: company ? str(company.name) : str(raw.companyName),
    ownerId: str(raw.ownerId),
    country: str(raw.country),
    clientType: str(raw.clientType),
    serviceRequirement: str(raw.serviceRequirement),
    opportunityType: str(raw.opportunityType),
    strategicImportance: str(raw.strategicImportance),
    expectedOutcome: str(raw.expectedOutcome),
    poc: bool(raw.poc),
    proposalShared: bool(raw.proposalShared),
    openDate: raw.openDate ? iso(raw.openDate) : null,
    createdAt: iso(raw.createdAt),
  }
}

export function toDealStats(raw: Raw): CrmDealStats {
  const breakdown = Array.isArray(raw.stageBreakdown) ? (raw.stageBreakdown as Raw[]) : []
  return {
    totalDeals: num(raw.totalDeals),
    activeDeals: num(raw.activeDeals),
    wonDeals: num(raw.wonDeals),
    lostDeals: num(raw.lostDeals),
    totalValue: num(raw.totalValue),
    dealsWithoutCompany: num(raw.dealsWithoutCompany),
    stageBreakdown: breakdown.map((b) => ({ stage: String(b.stage ?? ''), count: num(b.count) })),
  }
}

export function toEmailSummary(raw: Raw): CrmEmailSummary {
  const threads = Array.isArray(raw.threads) ? (raw.threads as Raw[]) : []
  return {
    ok: raw.ok !== false,
    threadCount: num(raw.threadCount),
    messageCount: num(raw.messageCount),
    lastContactAt: raw.lastContactAt ? iso(raw.lastContactAt) : null,
    threads: threads.map((t) => ({
      subject: String(t.subject ?? '(no subject)'),
      messageCount: num(t.messageCount),
      lastAt: iso(t.lastAt),
      lastDirection: String(t.lastDirection ?? 'unknown'),
      excerpts: (Array.isArray(t.excerpts) ? (t.excerpts as Raw[]) : []).map((e) => ({
        direction: String(e.direction ?? 'unknown'),
        at: iso(e.at),
        text: String(e.text ?? ''),
      })),
    })),
  }
}

/**
 * Removes whole blocks (`<style>...</style>`, `<script>`, `<head>`, comments) in ONE pass. Written with indexOf, not a pattern:
 * a pattern such as /<style[\s\S]*?<\/style>/ is quadratic when a sender repeats the opening tag without ever closing it.
 * The opening tag must be that tag (`<head>` is a block, `<header>` is not); the closing tag may have spaces before its ">".
 * An opening tag with no closing tag removes the rest (a browser would treat it the same way).
 */
function dropBlocks(text: string, open: string, close: string): string {
  const lower = text.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)) // same length as `text`, so positions line up
  const isComment = open === '<!--'
  let out = ''
  let from = 0
  for (;;) {
    let start = lower.indexOf(open, from)
    // `<head` must be followed by ">", "/" or white space: `<header>` is another tag
    while (start >= 0 && !isComment && !/[\s>/]/.test(lower.charAt(start + open.length))) start = lower.indexOf(open, start + 1)
    if (start < 0) return out + text.slice(from)
    out += text.slice(from, start) + ' '
    const end = lower.indexOf(close, start + open.length)
    if (end < 0) return out
    // `</style >`: skip to the ">" that ends the closing tag (at most 20 characters further)
    const gt = isComment ? -1 : lower.indexOf('>', end + close.length)
    from = isComment ? end + close.length : gt >= 0 && gt - (end + close.length) <= 20 ? gt + 1 : end + close.length
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...', laquo: '"', raquo: '"', copy: '(c)',
}
/** Common HTML entities, decoded once (never twice: "&amp;lt;" stays "&lt;"). */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,6})|#x([0-9a-f]{1,5})|([a-z]{2,8}));/gi, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole
    const code = dec ? Number(dec) : parseInt(hex!, 16)
    return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
  })
}

/**
 * Real HTML tag names only. A "<" followed by something else is TEXT ("<unsubscribe>", "<Please remove us>", "a<b", "1 < 2").
 * Block tags end a line; inline tags (`<span>`, `<b>`, `<font>`) disappear without a trace, so "un<span>subscribe</span>" is one word.
 */
const BLOCK_TAGS = 'br|p|div|tr|li|ul|ol|table|tbody|thead|tfoot|td|th|h[1-6]|blockquote|hr|pre|center|section|article|header|footer|nav|main|dl|dt|dd|form|title|body|html'
const INLINE_TAGS = 'span|a|b|i|u|em|strong|font|small|big|sub|sup|s|strike|code|abbr|cite|tt|label|img|meta|link|input|button|o:p|v:\\w+|w:\\w+|st1:\\w+|\\w+:smarttagtype'
const BLOCK_TAG = new RegExp(`</?(?:${BLOCK_TAGS})(?=[\\s/>])[^<>]{0,500}>`, 'gi')
const INLINE_TAG = new RegExp(`</?(?:${INLINE_TAGS})(?=[\\s/>])[^<>]{0,500}>`, 'gi')
const MARKUP_LEFTOVER = /<[!?][^<>]{0,500}>/g // <!DOCTYPE ...>, <?xml ...?>

/**
 * An email's text as plain text, cleaned in a fixed order so that nothing is slow for a hostile sender and nothing is hidden:
 *   1. cut the RAW text to ACTIVITY_BODY_RAW_MAX before anything else is done to it;
 *   2. remove style, script, head and comments (their text is not the message, and a long style block must not use up the cap);
 *   3. turn block tags into line breaks and inline tags into nothing (bounded: a tag name followed by no ">" within 500 characters is text);
 *   4. decode entities, tidy white space but KEEP line breaks (a quoted line is recognised by where it starts);
 *   5. only then cut to ACTIVITY_BODY_MAX.
 */
export function plainBody(v: unknown): string {
  const whole = String(v ?? '')
  const unread = whole.length > ACTIVITY_BODY_RAW_MAX
  let t = whole.slice(0, ACTIVITY_BODY_RAW_MAX)
  // an embedded image (data: URI) is not text: it must not fill the part of the message that is kept (linear: a bounded character class)
  if (t.includes('data:')) t = t.replace(DATA_URI, ' ')
  if (t.includes('<')) {
    t = dropBlocks(t, '<!--', '-->')
    t = dropBlocks(t, '<style', '</style')
    t = dropBlocks(t, '<script', '</script')
    t = dropBlocks(t, '<head', '</head')
    t = t.replace(BLOCK_TAG, '\n').replace(INLINE_TAG, '').replace(MARKUP_LEFTOVER, ' ')
  }
  const tidy = decodeEntities(t)
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  // Text beyond the raw cut was never read: say so in the text itself, so a short "UNSUBSCRIBE" followed by a wall of white space can never
  // look like a complete standalone message (the marker is other content, so the message is not a plain opt-out).
  // room is reserved for the marker, so it can never be cut off by the length limit: a message that was not read in full always says so
  return unread ? `${tidy.slice(0, ACTIVITY_BODY_MAX - ACTIVITY_UNREAD_MARKER.length - 1)}\n${ACTIVITY_UNREAD_MARKER}` : tidy.slice(0, ACTIVITY_BODY_MAX)
}
const DATA_URI = /data:[\w/+.-]{1,60};base64,[A-Za-z0-9+/=]{100,}/g

/** A whole token that is exactly one plain address: ASCII local part, dotted ASCII domain with a letters-only ending. Nothing else is an address. */
const STRICT_ADDRESS = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,6}[a-z]{2,24}$/i
/** A header longer than this is never read (only its start would be seen, and the real sender could be past it). */
const ADDRESS_HEADER_MAX = 2000
const FUTURE_SLACK_MS = 10 * 60_000

/**
 * The bare, lower-case addresses in a raw header value: "Name <A@B.com>", "a@b.com", "A <a@b.com>, c@d.org".
 *
 * WHOLE TOKENS ONLY. Each piece that contains an "@" (pieces are separated by WHITE SPACE only; one "<" in front and ">" "," ";" behind are
 * ignored) must itself be exactly one plain address - so smith,john@x.example, x"y@z.example and john(vendor@z.example) are refused and
 * never reduced to john@x.example / y@z.example / vendor@z.example. If ANY piece with an "@" is not (an apostrophe or "&" in the local part, a non-ASCII letter, a quoted local part, a
 * truncated domain, a trailing dot ...) the WHOLE header is refused and nothing is returned - a header is never "repaired" into a
 * different, valid-looking address: d'souza@acme.example must not become souza@acme.example. A header longer than 2,000 characters is
 * refused too. At most ACTIVITY_ADDRESSES_MAX addresses are returned.
 */
export function parseAddresses(v: unknown): string[] {
  const raw = String(v ?? '')
  if (raw.length > ADDRESS_HEADER_MAX) return []
  const out: string[] = []
  for (const piece of raw.split(/\s+/)) {
    if (!piece.includes('@')) continue
    // one optional "<" in front and ">" "," ";" behind - nothing else is ever removed, so no part of a piece is dropped to leave a different address
    const token = piece.replace(/^</, '').replace(/[>,;]+$/, '')
    if (token.length > 254 || !STRICT_ADDRESS.test(token)) return []
    const a = token.toLowerCase()
    if (!out.includes(a)) out.push(a)
  }
  return out.slice(0, ACTIVITY_ADDRESSES_MAX)
}

/**
 * LOOKUP ONLY - never to choose an address to write. Every plain address found in a free-text field such as a company's saved e-mail
 * ("a@x.com;b@x.com", "Ravi <r@x.com>, other@x.com"), with the looser splitting people actually type. It is used to ask "is one of this
 * company's addresses already on the suppression list?", where finding one address too many is harmless. parseAddresses() is the strict
 * reader used for everything that can be recorded.
 */
export function lookupAddresses(v: unknown): string[] {
  const raw = String(v ?? '')
  if (raw.length > ADDRESS_HEADER_MAX) return []
  const out: string[] = []
  for (const token of raw.split(/[\s<>(),;"]+/)) {
    if (token.length > 254 || !STRICT_ADDRESS.test(token)) continue
    const a = token.toLowerCase()
    if (!out.includes(a)) out.push(a)
  }
  return out.slice(0, ACTIVITY_ADDRESSES_MAX)
}

/**
 * `withBody`: keep the message text (see CrmActivity.body). Without it the object is exactly what it always was. The text is
 * processed only for an INBOUND email inside the window (older or outgoing messages are never read: `body` stays absent, so
 * nothing downstream mistakes it for an empty message that was read).
 */
export function toActivity(raw: Raw, withBody = false, now: Date = new Date()): CrmActivity {
  const createdAt = iso(raw.createdAt)
  const direction = str(raw.direction)
  const type = String(raw.type ?? '')
  const age = now.getTime() - new Date(createdAt).getTime()
  // a message dated in the future (more than a few minutes ahead) is never read: a sender must not be able to take the newest slots with a made-up date
  const readable = direction === 'inbound' && Number.isFinite(age) && age >= -FUTURE_SLACK_MS && age <= ACTIVITY_BODY_WINDOW_DAYS * 86_400_000
  return {
    id: String(raw.id),
    type,
    companyId: str(raw.companyId),
    subject: str(raw.subject) ?? str(raw.title),
    direction,
    createdAt,
    ...(withBody && readable
      ? {
          body: plainBody(raw.body),
          fromAddresses: parseAddresses(raw.fromEmail),
          matchedAddress: parseAddresses(raw.matchedCompanyEmail)[0] ?? null,
          ownAddresses: [...new Set([...parseAddresses(raw.mailboxEmail), ...parseAddresses((raw.user as Raw | undefined)?.email)])].slice(0, ACTIVITY_ADDRESSES_MAX),
        }
      : {}),
  }
}

/**
 * GET /api/dropdowns/:fieldKey returns DropdownOption rows for curated fields,
 * but computed {value,label} objects for Lead Owner and for derived fields
 * (CMS, Remarks). Both shapes carry value/label, so one mapper covers them.
 */
export function toDropdownOption(raw: Raw): CrmDropdownOption {
  const value = String(raw.value ?? '')
  return { value, label: String(raw.label ?? value) }
}

export function toDropdownField(raw: Raw): CrmDropdownField {
  return {
    fieldKey: String(raw.fieldKey ?? ''),
    label: String(raw.label ?? ''),
    group: String(raw.group ?? ''),
  }
}

export function toCustomFieldDef(raw: Raw): CrmCustomFieldDef {
  return {
    key: String(raw.key ?? ''),
    label: String(raw.label ?? ''),
    type: String(raw.type ?? 'text'),
    required: bool(raw.required),
  }
}

export function toUser(raw: Raw): CrmUser {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    email: String(raw.email ?? ''),
    role: String(raw.role ?? 'member'),
  }
}
