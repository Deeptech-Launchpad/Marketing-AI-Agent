import { env } from '../config/env.js'

// MULTI-SOURCE HIRING SIGNALS — the board registry.
//
// BUSINESS SOURCE: Team Answer, Section D.1 and Section 8 of the
// implementation brief:
//
//   "multi-platform, region-based sourcing — LinkedIn and Indeed globally,
//    plus region-specific platforms (Seek for Australia/NZ, PNet/Careers24 for
//    South Africa, Bayt/GulfTalent for UAE, JobStreet/JobsDB for Singapore)"
//
// and the instruction not to depend on one signal provider.
//
// Boards are DATA, not code. Which board serves which country, and which
// collector fetches it, is a table — so adding "other relevant regional job
// sources where available" is a row rather than a rewrite.
//
// ─────────────────────────────────────────────────────────────────────────
// THE LINKEDIN CONFLICT, STATED RATHER THAN RESOLVED QUIETLY
//
// Section D.1 names LinkedIn as a global job source. Sections 3 and 22 forbid
// scraping LinkedIn and forbid using third-party scraping as a workaround for
// prohibited LinkedIn automation. Those two instructions cannot both be
// honoured by pointing a scraping Actor at LinkedIn, so this registry does not.
//
// LinkedIn is registered, and reports `blocked_by_policy` until official API
// access is configured. It is present so the gap is visible in every report,
// rather than absent so it looks like nobody asked for it.
// ─────────────────────────────────────────────────────────────────────────

export type BoardAvailability =
  | { status: 'available'; actorId: string }
  | { status: 'not_configured'; reason: string }
  | { status: 'blocked_by_policy'; reason: string }
  | { status: 'not_applicable'; reason: string }

export interface JobBoard {
  id: string
  name: string
  /**
   * ISO-3166 alpha-2 countries this board serves, or `global`. Matched against
   * the company's country, so a South African distributor is not searched on
   * JobStreet and billed for the privilege.
   */
  countries: 'global' | string[]
  /** Which env var names the collector Actor for this board. */
  actorEnvKey: string
  /** Set when the board may not be collected at all, whatever the config. */
  policyBlock?: string
}

/**
 * The registry.
 *
 * Country coverage is scoped to the ten confirmed target geographies
 * (Section 5): USA, UK, Canada, South Africa, New Zealand, Australia, Malta,
 * Ireland, UAE, Singapore.
 */
export const JOB_BOARDS: JobBoard[] = [
  {
    id: 'indeed',
    name: 'Indeed',
    countries: 'global',
    actorEnvKey: 'APIFY_JOBS_ACTOR',
  },
  {
    id: 'linkedin',
    name: 'LinkedIn Jobs',
    countries: 'global',
    actorEnvKey: 'LINKEDIN_JOBS_ACTOR',
    policyBlock:
      'LinkedIn job collection requires official LinkedIn API access. Scraping it — directly or through a ' +
      'third-party collector — is prohibited by the approved provider policy, which names third-party scraping ' +
      'as a workaround explicitly. Configure official access to enable this source.',
  },
  {
    id: 'seek',
    name: 'Seek',
    countries: ['AU', 'NZ'],
    actorEnvKey: 'APIFY_SEEK_ACTOR',
  },
  {
    id: 'pnet',
    name: 'PNet',
    countries: ['ZA'],
    actorEnvKey: 'APIFY_PNET_ACTOR',
  },
  {
    id: 'careers24',
    name: 'Careers24',
    countries: ['ZA'],
    actorEnvKey: 'APIFY_CAREERS24_ACTOR',
  },
  {
    id: 'bayt',
    name: 'Bayt',
    countries: ['AE'],
    actorEnvKey: 'APIFY_BAYT_ACTOR',
  },
  {
    id: 'gulftalent',
    name: 'GulfTalent',
    countries: ['AE'],
    actorEnvKey: 'APIFY_GULFTALENT_ACTOR',
  },
  {
    id: 'jobstreet',
    name: 'JobStreet',
    countries: ['SG'],
    actorEnvKey: 'APIFY_JOBSTREET_ACTOR',
  },
  {
    id: 'jobsdb',
    name: 'JobsDB',
    countries: ['SG'],
    actorEnvKey: 'APIFY_JOBSDB_ACTOR',
  },
]

/**
 * Normalises the country strings NXT Sales actually holds.
 *
 * The CRM stores free text — "USA", "United States", "U.A.E." — so a country
 * is matched by name as well as by code. An unrecognised country is returned
 * as null rather than guessed, which means only the global boards run: fewer
 * signals, and no wrong ones.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  us: 'US', usa: 'US', 'united states': 'US', 'united states of america': 'US', america: 'US',
  uk: 'GB', gb: 'GB', 'united kingdom': 'GB', britain: 'GB', 'great britain': 'GB', england: 'GB',
  scotland: 'GB', wales: 'GB', 'northern ireland': 'GB',
  ca: 'CA', canada: 'CA',
  za: 'ZA', 'south africa': 'ZA', rsa: 'ZA',
  nz: 'NZ', 'new zealand': 'NZ',
  au: 'AU', australia: 'AU', aus: 'AU',
  mt: 'MT', malta: 'MT',
  ie: 'IE', ireland: 'IE', eire: 'IE', 'republic of ireland': 'IE',
  ae: 'AE', uae: 'AE', 'united arab emirates': 'AE', 'u a e': 'AE', dubai: 'AE', 'abu dhabi': 'AE',
  sg: 'SG', singapore: 'SG',
}

export function normalizeCountry(raw: string | null | undefined): string | null {
  if (!raw) return null
  const key = String(raw).toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
  return COUNTRY_ALIASES[key] ?? (/^[a-z]{2}$/.test(key) ? key.toUpperCase() : null)
}

/** Whether a board covers a country. A null country gets global boards only. */
export function boardServes(board: JobBoard, country: string | null): boolean {
  if (board.countries === 'global') return true
  if (!country) return false
  return board.countries.includes(country)
}

/**
 * What this board can do right now, and if it cannot, precisely why.
 *
 * The four outcomes are deliberately distinct. `not_applicable` means we chose
 * not to search it, `not_configured` means nobody has given us a collector,
 * and `blocked_by_policy` means we may not — reading any of those as "no
 * hiring activity" would be wrong, and they are the three ways that mistake
 * gets made.
 */
export function boardAvailability(board: JobBoard, country: string | null): BoardAvailability {
  if (!boardServes(board, country)) {
    return {
      status: 'not_applicable',
      reason: `${board.name} serves ${(board.countries as string[]).join(', ')}; this company is in ${
        country ?? 'an unstated country'
      }.`,
    }
  }
  if (board.policyBlock) {
    return { status: 'blocked_by_policy', reason: board.policyBlock }
  }
  const actorId = (env as unknown as Record<string, string>)[board.actorEnvKey] ?? ''
  if (!actorId) {
    return {
      status: 'not_configured',
      reason: `${board.actorEnvKey} is not set, so ${board.name} cannot be collected. No signal is inferred from its absence.`,
    }
  }
  return { status: 'available', actorId }
}

/** Every board that applies to a country, with its current availability. */
export function boardsFor(country: string | null): Array<{ board: JobBoard; availability: BoardAvailability }> {
  return JOB_BOARDS.filter((b) => boardServes(b, country)).map((board) => ({
    board,
    availability: boardAvailability(board, country),
  }))
}
