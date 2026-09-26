// PRIMARY AND ALTERNATIVE — WHO TO APPROACH, AND WHO TO APPROACH INSTEAD.
//
// Discovery already produces a ranked shortlist. What it did not say is which
// of them a salesperson should actually pick up the phone about, and what to
// do when that person does not answer. "Here are four names ordered by a
// score" leaves that decision to whoever is reading, every time.
//
// So one candidate is named PRIMARY and, when the company has one, a second is
// named ALTERNATIVE. Nothing is discovered here and no field is filled in:
// this is a designation over candidates that already exist, computed from the
// rank the engine already assigned.
//
// The alternative is deliberately not "the next row down". A second name is
// only useful as a fallback if it is a genuinely different route into the same
// company, so it must be a different person, at the same company, and — where
// the shortlist allows it — in a different role group. Two people with the
// same job in the same team fail in the same way.

/** The subset of a scored candidate this module needs. */
export interface ContactRoleInput {
  identityKey: string
  fullName: string
  roleGroup: string | null
  companyMatch: string
  email: string | null
  phone: string | null
  profileUrl: string | null
  rank: number | null
  rankScore: number
  outcome: string
}

export type ContactRole = 'primary' | 'alternative' | null

export interface ContactRoleAssignment {
  /** identityKey of the primary, or null when the shortlist is empty. */
  primaryKey: string | null
  /** identityKey of the alternative, or null when there is no second route. */
  alternativeKey: string | null
  /**
   * Why the alternative is who it is — or why there is none.
   *
   * Rendered to the operator verbatim. "No alternative contact" and "only one
   * person was verified at this company" are different facts, and a salesperson
   * planning an approach needs the second one.
   */
  note: string
}

/**
 * Names the primary and alternative contacts from a shortlist.
 *
 * `candidates` must already be in the engine's rank order; this function does
 * not re-rank, because re-ranking here would mean two orderings in the system
 * that could disagree.
 */
export function assignContactRoles(candidates: ContactRoleInput[]): ContactRoleAssignment {
  const shortlisted = candidates.filter((c) => c.outcome === 'shortlisted')

  if (shortlisted.length === 0) {
    return {
      primaryKey: null,
      alternativeKey: null,
      note: 'No candidate was shortlisted for this company, so there is no contact to approach and none to fall back on.',
    }
  }

  const primary = shortlisted[0]!
  const others = shortlisted.slice(1).filter((c) => c.identityKey !== primary.identityKey)

  if (others.length === 0) {
    return {
      primaryKey: primary.identityKey,
      alternativeKey: null,
      note: `Only one person could be verified at this company, so there is no alternative contact. That is a finding about what the sources hold, not a gap in the search.`,
    }
  }

  // A different route in, rather than the next row down. Same company by
  // construction; a different role group where one exists, because two people
  // doing the same job in the same team are unreachable for the same reasons.
  const differentRole = others.find(
    (c) => c.roleGroup && primary.roleGroup && c.roleGroup !== primary.roleGroup,
  )
  const reachable = others.find((c) => c.email || c.phone)
  const alternative = differentRole ?? reachable ?? others[0]!

  const why = differentRole
    ? `${alternative.fullName} covers a different function (${alternative.roleGroup}) at the same company, so an approach that stalls with ${primary.fullName} has somewhere else to go.`
    : reachable
      ? `${alternative.fullName} is the next shortlisted person at this company with a stated contact detail.`
      : `${alternative.fullName} is the next shortlisted person at this company. No contact detail was stated for them by any source.`

  return { primaryKey: primary.identityKey, alternativeKey: alternative.identityKey, note: why }
}

/** What to print where a provider stated nothing. Never a blank, never a guess. */
export const NOT_FOUND = 'Not found'

/**
 * A contact detail as it should be read.
 *
 * The distinction this preserves is the one the whole engine rests on: a field
 * is either something a source stated, or it is nothing at all. There is no
 * third case where a plausible value gets printed because it would look
 * better — no first.last@domain, no info@, no pattern completed from a name.
 */
export function statedOrNotFound(value: string | null | undefined): string {
  const v = value?.trim()
  return v ? v : NOT_FOUND
}
