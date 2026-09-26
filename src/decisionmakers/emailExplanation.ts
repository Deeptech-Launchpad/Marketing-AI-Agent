import { normalizePersonName } from './candidates.js'

// ── WHERE A CONTACT DETAIL CAME FROM, AND WHY THERE ISN'T ONE ──────────────
//
// The card used to print "No email address recorded" for four situations that
// call for four different actions:
//
//   the record holds an address that names this person   -> use it
//   the record holds only a shared mailbox               -> nothing to do; a
//                                                           shared inbox is
//                                                           never a person
//   the record holds addresses naming somebody else      -> look at the other
//                                                           contacts
//   no provider was authorised to look                   -> configure one
//
// All four are already recorded — in the candidate's evidence and in the run's
// per-provider metadata — so this derives them at read time rather than adding
// a column. Nothing here computes a contact detail; it only explains one that
// already exists, or its absence.

interface EvidenceRow {
  provider?: string
  supports?: string[]
  snippet?: string
}

interface ProviderRow {
  provider?: string
  status?: string
  reason?: string
  metadata?: Record<string, unknown>
}

export interface EmailExplanation {
  found: boolean
  source: string | null
  sourceLabel: string | null
  note: string
}

/** Which provider stated this candidate's email. Null when none did. */
export function emailSourceOf(evidence: unknown, email?: string | null): string | null {
  if (!Array.isArray(evidence)) return null
  const rows = (evidence as EvidenceRow[]).filter((e) => Array.isArray(e?.supports) && e.supports.includes('contact'))
  // Prefer the sighting whose own text carries this exact address, so a merged
  // person whose address came from a second source is not credited to the first.
  const exact = email
    ? rows.find((e) => typeof e.snippet === 'string' && e.snippet.toLowerCase().includes(email.toLowerCase()))
    : undefined
  return (exact ?? rows[0])?.provider ?? null
}

/** A provider name as an operator would say it. */
export function providerLabel(name: string | null): string {
  if (!name) return 'an unnamed source'
  const map: Record<string, string> = {
    crm_contacts: 'NXT Sales CRM record',
    hunter: 'Hunter (address observed on a public page)',
    apollo: 'Apollo',
    zoominfo: 'ZoomInfo',
    rocketreach: 'RocketReach',
    intent_social: 'Intent Signals',
    linkedin_reference: 'LinkedIn reference',
    company_website: 'the company website',
    public_web_research: 'a public web page',
  }
  return map[name] ?? name.replace(/_/g, ' ')
}

/**
 * Sources that attach an address to a person only when the address's local
 * part names them. Every other source states the address as the person's in
 * its own record, and the wording must not claim more than that.
 */
const NAME_MATCHED_EMAIL_SOURCES = new Set(['crm_contacts', 'public_web_research'])

/** First + last of a normalised name, so "Jane A. Smith" finds "Jane Smith". */
function shortName(name: string): string {
  const parts = normalizePersonName(name).split(' ').filter(Boolean)
  return parts.length > 2 ? `${parts[0]} ${parts[parts.length - 1]}` : parts.join(' ')
}

/**
 * The CRM's per-contact email outcome for this candidate.
 *
 * Outcomes are keyed by the name as the CRM entry wrote it, while a merged
 * candidate carries the fullest name any source gave. An exact key is used
 * when present; otherwise a single key with the same normalised first+last
 * name, or a single key named in this candidate's own CRM evidence. Anything
 * ambiguous yields nothing rather than another person's outcome.
 */
export function crmEmailOutcomeFor(
  candidate: { fullName: string; evidence: unknown },
  outcomes: Record<string, string> | undefined,
): string | undefined {
  if (!outcomes) return undefined
  if (Object.prototype.hasOwnProperty.call(outcomes, candidate.fullName)) return outcomes[candidate.fullName]
  const keys = Object.keys(outcomes)
  const target = shortName(candidate.fullName)
  const byName = keys.filter((k) => target && shortName(k) === target)
  if (byName.length === 1) return outcomes[byName[0]!]
  if (byName.length > 1) return undefined

  const crmText = (Array.isArray(candidate.evidence) ? (candidate.evidence as EvidenceRow[]) : [])
    .filter((e) => e?.provider === 'crm_contacts' && typeof e.snippet === 'string')
    .map((e) => ` ${normalizePersonName(e.snippet!)} `)
    .join(' ')
  if (!crmText.trim()) return undefined
  const inEvidence = keys.filter((k) => {
    const n = normalizePersonName(k)
    return n.length >= 3 && crmText.includes(` ${n} `)
  })
  return inEvidence.length === 1 ? outcomes[inEvidence[0]!] : undefined
}

/**
 * The contactability line for one candidate, in the words the screen prints.
 *
 * `found` drives nothing but the wording — the email itself is whatever the
 * engine stored, and this never supplies one.
 */
export function explainEmail(
  candidate: { fullName: string; email: string | null; evidence: unknown; contactability?: string | null },
  providerResults: unknown,
): EmailExplanation {
  if (!candidate.email && candidate.contactability === 'withheld_by_policy') {
    return {
      found: false,
      source: null,
      sourceLabel: null,
      note: 'A source stated contact details for this person, but DM_STORE_CONTACT_DATA is off, so they were not stored. This is a policy decision, not a data gap.',
    }
  }
  if (candidate.email) {
    const source = emailSourceOf(candidate.evidence, candidate.email)
    const how =
      source && NAME_MATCHED_EMAIL_SOURCES.has(source)
        ? `linked to ${candidate.fullName} because the address itself names them`
        : `recorded by that source as ${candidate.fullName}'s address`
    return {
      found: true,
      source,
      sourceLabel: providerLabel(source),
      note: `Stated by ${providerLabel(source)} and ${how}. It was not constructed from the name or the domain.`,
    }
  }

  const rows = (Array.isArray(providerResults) ? providerResults : []) as ProviderRow[]
  const crm = rows.find((r) => r.provider === 'crm_contacts')
  const outcome = crmEmailOutcomeFor(candidate, crm?.metadata?.emailOutcomes as Record<string, string> | undefined)
  const generic = (crm?.metadata?.genericMailboxesRejected as string[] | undefined) ?? []

  if (outcome === 'generic_mailbox_only') {
    return {
      found: false,
      source: null,
      sourceLabel: null,
      note: `No verified person email. The CRM record holds only shared mailbox(es) — ${generic.join(', ')} — and a shared inbox is never assigned to a person.`,
    }
  }
  if (outcome === 'ambiguous') {
    return {
      found: false,
      source: null,
      sourceLabel: null,
      note: 'No verified person email. More than one stored address could name this person, so none was chosen.',
    }
  }
  if (outcome === 'no_address_names_this_person') {
    return {
      found: false,
      source: null,
      sourceLabel: null,
      note: 'No verified person email. The CRM record holds addresses, but none of them names this person.',
    }
  }

  const hunter = rows.find((r) => r.provider === 'hunter')
  const hunterGeneric = Number(hunter?.metadata?.genericMailboxes ?? 0)
  if (hunterGeneric > 0) {
    return {
      found: false,
      source: null,
      sourceLabel: null,
      note: `No verified person email. Hunter holds ${hunterGeneric} shared mailbox(es) for this domain and no address attributable to a named person; no address was guessed from the organisation's pattern.`,
    }
  }

  return {
    found: false,
    source: null,
    sourceLabel: null,
    note: 'No verified person email. No source stated an address for this person, and none was guessed from the name or the domain.',
  }
}
