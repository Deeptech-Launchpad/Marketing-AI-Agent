import { looksLikeJobTitle } from '../peopleExtraction.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — contacts already recorded on the NXT Sales company record.
//
// READ ONLY. Nothing here writes to NXT Sales, and no contact is created,
// updated or exported.
//
// This turned out to be the strongest source actually available: 9,242 of the
// 15,137 company records carry at least one contact person, and many carry the
// job title alongside the name, written by a human who spoke to them. That is
// better provenance than any data aggregator sells.
//
// Storage format is a JSON array of free-text strings, in practice either
// "Gary Harte - Shop Manager" or a bare "Mark Gannon". Both are handled; the
// bare form yields a person with NO title, which the engine will then decline
// to shortlist because relevance cannot be established without one.

/**
 * Splits "Name - Title" at the FIRST dash only, keeping the title verbatim.
 *
 * Both halves of that rule were forced by real CRM rows:
 *
 *   "Bronc (Phillip) Kau - President"     splitting on parentheses gave the
 *                                         name "Bronc" and the title
 *                                         "Phillip) Kau President" — a mangled
 *                                         name for a real person.
 *   "Tommy Schreiner - Sales | President" splitting on the pipe and rejoining
 *                                         gave "Sales President", a title
 *                                         nobody wrote.
 *
 * So parentheses and pipes are NOT separators, and everything after the first
 * dash is kept exactly as stored. A comma is accepted as a separator only when
 * what follows actually reads as a job title, so "Smith, Jane" stays a name.
 */
function splitNameAndTitle(entry: string): { name: string; title: string | null } {
  const cleaned = entry.trim().replace(/\s+/g, ' ')

  const dash = cleaned.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (dash) return { name: cleanName(dash[1]!), title: dash[2]!.trim() || null }

  const comma = cleaned.match(/^([^,]+),\s*(.+)$/)
  if (comma && looksLikeJobTitle(comma[2]!)) {
    return { name: cleanName(comma[1]!), title: comma[2]!.trim() }
  }

  return { name: cleanName(cleaned), title: null }
}

/**
 * Strips a phone number some records carry inside the contact-person string,
 * e.g. "Tom Crowhurst, 073597767046 - Marketing Manager".
 *
 * Found in the real CRM. It matters twice over: it is not part of anyone's
 * name, and leaving it there wrote a phone number into the `fullName` column,
 * where the contact-data redaction does not reach. The number is discarded
 * rather than moved to `phone`, because a digit string sitting next to a name
 * could equally be the company switchboard, and deciding otherwise would be
 * exactly the inference this stage forbids.
 */
function cleanName(raw: string): string {
  return raw
    .replace(/\+?\d[\d\s().-]{5,}\d/g, ' ')
    .replace(/\s*[,;|]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Mailboxes that belong to a company, never to a person. */
const GENERIC_MAILBOX =
  /^(?:info|sales|admin|enquir(?:y|ies)|inquir(?:y|ies)|contact|office|accounts?|billing|support|help|hello|hi|mail|email|team|orders?|service|customerservice|noreply|no-reply|donotreply|webmaster|postmaster|marketing|careers|jobs|hr|purchasing|quotes?|reception)$/i

/**
 * Why a person did or did not end up with a stored address.
 *
 * Reported so the interface can tell four different situations apart instead
 * of printing one sentence for all of them: an empty record, a record holding
 * only shared mailboxes, a record whose addresses name somebody else, and a
 * record where the answer is genuinely ambiguous.
 */
export type StoredEmailReason =
  | 'matched'
  | 'no_address_on_record'
  | 'generic_mailbox_only'
  | 'no_address_names_this_person'
  | 'ambiguous'

export interface StoredEmailMatch {
  email: string | null
  reason: StoredEmailReason
  /** The shared mailboxes that were rejected, for the reason line. */
  rejectedGeneric: string[]
}

/** How strongly a stored address names a person. */
type NameMatch = 'full' | 'partial' | null

/** Addresses on the record: parsed, de-duplicated, in the order first seen. */
function parseAddresses(stored: Array<string | null | undefined>): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const blob of stored) {
    for (const raw of String(blob ?? '').split(/[\s,;]+/)) {
      const e = raw.trim().replace(/^mailto:/i, '')
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(e)) continue
      const key = e.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

/** The name's own tokens, with its first name and surname. */
function nameTokens(name: string): { first: string; surname: string } | null {
  const tokens = name
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 1)
  if (tokens.length === 0) return null
  return { first: tokens[0]!, surname: tokens[tokens.length - 1]! }
}

/**
 * How strongly this address's local part names this person.
 *
 *   full     the local part carries the SURNAME and the first name or its
 *            initial — "lloyd.robertson@", "l.robertson@", "robertsonl@"
 *   partial  the local part IS the first name, or IS the surname, exactly —
 *            "lloyd@", "robertson@"
 *
 * `partial` is the case this was rewritten for. A first-name-only mailbox is
 * how small businesses actually write addresses, and requiring the surname
 * rejected every one of them. It is weaker evidence, so it is accepted only
 * when nothing else on the record competes for it — see assignStoredEmails.
 *
 * The partial test is EXACT equality, never "contains": a local part of
 * "sales" must not count as naming a person called "Sal", and "lloyds" is not
 * "lloyd".
 */
function nameMatch(local: string, name: string): NameMatch {
  const parts = nameTokens(name)
  if (!parts) return null
  const flat = local.toLowerCase().replace(/[^a-z]/g, '')
  if (!flat) return null

  const hasSurname = flat.includes(parts.surname)
  const hasFirst = flat.includes(parts.first)
  const hasInitial = flat.startsWith(parts.first[0]!) || flat.endsWith(parts.first[0]!)
  if (hasSurname && (hasFirst || hasInitial)) return 'full'

  if (flat === parts.first || flat === parts.surname) return 'partial'
  return null
}

/**
 * Decides, for EVERY contact person on the record at once, which stored
 * address names them.
 *
 * WHY ALL OF THEM TOGETHER. The rule is "if multiple possible person-email
 * matches are ambiguous, do not choose one", and ambiguity is a property of
 * the whole record rather than of one person. An address that could equally be
 * either of two contacts belongs to neither, and that can only be seen by
 * considering both.
 *
 * THE TWO DEFECTS THIS REPLACES, both found on one real record —
 * "1stop Welding Shop", contactPersons ["Lloyd Robertson - Managing Director"],
 * email "lloyd@aes-sales.com" — which between them produced no email at all:
 *
 *   1. THE SURNAME WAS MANDATORY. "lloyd@" does not contain "robertson", so a
 *      first-name mailbox could never match anybody.
 *
 *   2. THE SAME ADDRESS COUNTED TWICE. NXT Sales stores the address in BOTH
 *      `Company.email` and `Company.emails[]`, so the caller passed
 *      ["lloyd@…", "lloyd@…"]. The old rule "exactly one address may claim a
 *      person" then saw TWO matches and refused. That defect alone disabled
 *      CRM email matching for 7,521 of the 7,914 company records holding both
 *      a contact person and an email — 95% of them — including records with a
 *      textbook "first.last@" address. De-duplication is why parseAddresses
 *      exists, and it is the more serious of the two.
 *
 * WHAT IT STILL WILL NOT DO. It never builds an address. Nothing is
 * concatenated, no pattern is applied, and no local part is generated from a
 * name. Every address it returns already existed in NXT Sales, character for
 * character, before this function ran. A shared mailbox is rejected outright,
 * however well it appears to fit.
 */
export function assignStoredEmails(
  names: string[],
  stored: Array<string | null | undefined>,
): Map<string, StoredEmailMatch> {
  const out = new Map<string, StoredEmailMatch>()
  const all = parseAddresses(stored)

  const rejectedGeneric = all.filter((e) => GENERIC_MAILBOX.test(e.split('@')[0]!.replace(/[^a-z]/gi, '')))
  const personal = all.filter((e) => !rejectedGeneric.includes(e))

  const emptyReason: StoredEmailReason =
    all.length === 0 ? 'no_address_on_record' : 'generic_mailbox_only'

  if (personal.length === 0) {
    for (const n of names) out.set(n, { email: null, reason: emptyReason, rejectedGeneric })
    return out
  }

  // The best address per person, at the strongest strength that person reaches.
  const provisional = new Map<string, string>()
  for (const n of names) {
    const scored = personal
      .map((e) => ({ email: e, strength: nameMatch(e.split('@')[0]!, n) }))
      .filter((x): x is { email: string; strength: 'full' | 'partial' } => x.strength !== null)

    if (scored.length === 0) {
      out.set(n, { email: null, reason: 'no_address_names_this_person', rejectedGeneric })
      continue
    }
    const best = scored.some((x) => x.strength === 'full') ? 'full' : 'partial'
    const top = scored.filter((x) => x.strength === best)
    // Two addresses naming one person equally well is not decisive.
    if (top.length !== 1) {
      out.set(n, { email: null, reason: 'ambiguous', rejectedGeneric })
      continue
    }
    provisional.set(n, top[0]!.email)
  }

  // An address claimed by more than one person belongs to neither of them.
  const claims = new Map<string, number>()
  for (const e of provisional.values()) {
    const k = e.toLowerCase()
    claims.set(k, (claims.get(k) ?? 0) + 1)
  }

  for (const [n, e] of provisional) {
    out.set(
      n,
      (claims.get(e.toLowerCase()) ?? 0) > 1
        ? { email: null, reason: 'ambiguous', rejectedGeneric }
        : { email: e, reason: 'matched', rejectedGeneric },
    )
  }

  for (const n of names) if (!out.has(n)) out.set(n, { email: null, reason: emptyReason, rejectedGeneric })
  return out
}

/**
 * One person's stored address. A thin read over assignStoredEmails, kept
 * because a single name is the common shape at a call site and in a test.
 *
 * A single name cannot see cross-person ambiguity, so the provider itself
 * always calls assignStoredEmails with the whole contact list.
 */
export function matchStoredEmail(name: string, stored: Array<string | null | undefined>): string | null {
  return assignStoredEmails([name], stored).get(name)?.email ?? null
}

/** The reason line carried into the evidence, so the drawer explains itself. */
export function storedEmailNote(m: StoredEmailMatch): string {
  switch (m.reason) {
    case 'matched':
      return `stored NXT Sales address naming this person: ${m.email}`
    case 'generic_mailbox_only':
      return `no personal address on the record — only shared mailbox(es): ${m.rejectedGeneric.join(', ')}, which are never assigned to a person`
    case 'no_address_names_this_person':
      return 'the record holds addresses, but none of their local parts names this person'
    case 'ambiguous':
      return 'more than one stored address could name this person, so none was chosen'
    default:
      return 'no email address is recorded on the NXT Sales company record'
  }
}

/**
 * Attaches a stored LinkedIn URL to a person ONLY when the URL itself contains
 * that person's name.
 *
 * The field is free text and frequently holds several URLs for several people
 * in one string, e.g. ".../pat-o-brien-4259aa4b/ / .../joanna-rose-69708b111/".
 * Handing the first URL to the first contact would be inferring a profile from
 * a name, which Stage 4 forbids. Instead the URL slug must contain the name, so
 * the association comes from the URL, not from the ordering. When it is
 * ambiguous, the profile stays null.
 */
export function matchProfileUrl(name: string, profileBlob: string[]): string | null {
  const urls = profileBlob
    .flatMap((b) => String(b).split(/\s+|,|;/))
    .map((u) => u.trim().replace(/[/\s]+$/, ''))
    .filter((u) => /^https?:\/\//i.test(u))

  if (!urls.length) return null

  // Parenthesised and quoted nicknames are dropped before tokenising: a
  // LinkedIn slug is built from the formal name, so requiring "phillip" from
  // "Bronc (Phillip) Kau" would reject that person's own real profile.
  const tokens = name
    .replace(/\([^)]*\)/g, ' ')
    .replace(/["'“”‘’][^"'“”‘’]*["'“”‘’]/g, ' ')
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter((t) => t.length > 1)
  if (!tokens.length) return null

  // Every name token must appear in the slug. "pat o brien" -> the slug
  // "pat-o-brien-4259aa4b" contains pat, o(skipped, too short), brien.
  const matches = urls.filter((u) => {
    const slug = u.toLowerCase().replace(/[^a-z]/g, '')
    return tokens.every((t) => slug.includes(t))
  })

  // Exactly one URL may claim a person. Two means the slug is not decisive.
  return matches.length === 1 ? matches[0]! : null
}

export class CrmContactProvider implements DecisionMakerProvider {
  readonly name = 'crm_contacts'
  readonly sourceType = 'crm_record'

  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string } {
    if (ctx && ctx.company.contactPersons.length === 0) {
      return {
        status: 'no_results',
        reason: `CRM company record ${ctx.company.id} has no contact persons recorded.`,
      }
    }
    return { status: 'available' }
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()
    const company = ctx.company
    const drafts: CandidateDraft[] = []
    let unnamed = 0

    const entries = company.contactPersons.slice(0, ctx.maxResults).map((e) => String(e ?? '').trim())
    const parsed = entries.filter(Boolean).map((raw) => ({ raw, ...splitNameAndTitle(raw) }))

    // Every contact person is resolved against every stored address in ONE
    // pass, because ambiguity is a property of the record rather than of a
    // person: an address that could equally be either of two contacts belongs
    // to neither, and that cannot be seen one name at a time.
    const assigned = assignStoredEmails(
      parsed.filter((p) => p.name.length >= 3).map((p) => p.name),
      [company.email, ...company.emails],
    )

    for (const { raw, name, title } of parsed) {
      if (name.length < 3) {
        unnamed++
        continue
      }

      const profileUrl = matchProfileUrl(name, company.linkedProfiles)
      // Contact data ALREADY IN THE CRM, attached only where the stored value
      // names this person. Discarding it was losing real, already-owned data
      // and sending the engine to a paid provider for something NXT Sales
      // already held.
      const match = assigned.get(name) ?? {
        email: null,
        reason: 'no_address_on_record' as const,
        rejectedGeneric: [],
      }
      const email = match.email

      const supports: Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'> = ['name', 'company']
      if (title) supports.push('title')
      if (profileUrl) supports.push('profile_url')
      if (email) supports.push('contact')

      drafts.push({
        fullName: name,
        rawTitle: title,
        statedCompany: company.name,
        profileUrl,
        providerPersonId: null,
        // An address the CRM already holds, and only when its local part
        // names this person. A shared mailbox — info@, sales@, accounts@ — is
        // rejected outright: it is real and it is nobody's, and attributing it
        // to an individual would be exactly the guess this stage prohibits.
        email,
        // Phone stays null. The CRM's number is company-level, and the digits
        // some records carry inside a contact string could equally be the
        // switchboard — see cleanName above. The company's own number is
        // reported separately by the route, as the company's.
        phone: null,
        location: null,
        evidence: [
          {
            provider: this.name,
            sourceType: 'crm_record',
            sourceUrl: null,
            snippet:
              `NXT Sales company ${company.id} ("${company.name}") — contactPersons entry: "${raw}"` +
              (profileUrl ? ` | linkedProfiles entry matching this name: ${profileUrl}` : '') +
              // Stated whether or not an address was found, so the drawer
              // answers "why is there no email" without a second lookup.
              ` | ${storedEmailNote(match)}`,
            // The CRM row's own last-modified date: when this record was last
            // touched, which is the closest thing to an observation date.
            observedAt: company.updatedAt ? new Date(company.updatedAt) : null,
            supports,
          },
        ],
      })
    }

    return {
      provider: this.name,
      status: drafts.length ? 'available' : 'no_results',
      candidates: drafts,
      reason: drafts.length ? undefined : 'No usable contact-person entries on the CRM record.',
      durationMs: Date.now() - started,
      metadata: {
        entriesOnRecord: company.contactPersons.length,
        // How much of what the CRM already held was actually carried through.
        withStoredEmail: drafts.filter((d) => d.email).length,
        withStoredProfile: drafts.filter((d) => d.profileUrl).length,
        withTitle: drafts.filter((d) => d.rawTitle).length,
        unusableEntries: unnamed,
        // Per-person outcome, so "no email" can be explained rather than
        // merely displayed.
        emailOutcomes: Object.fromEntries([...assigned].map(([n, m]) => [n, m.reason])),
        genericMailboxesRejected: [...new Set([...assigned.values()].flatMap((m) => m.rejectedGeneric))],
      },
    }
  }
}
