import { looksLikeJobTitle } from '../peopleExtraction.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — contacts already recorded on the NXT Sales company record.
//
// READ ONLY. Nothing here writes to NXT Sales, and no contact is created,
// updated or exported.
//
// This turned out to be the strongest source actually available: 9,242 of the
// 15,158 company records carry at least one contact person, and many carry the
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

    for (const entry of company.contactPersons.slice(0, ctx.maxResults)) {
      const raw = String(entry ?? '').trim()
      if (!raw) continue

      const { name, title } = splitNameAndTitle(raw)
      if (name.length < 3) {
        unnamed++
        continue
      }

      const profileUrl = matchProfileUrl(name, company.linkedProfiles)

      const supports: Array<'name' | 'title' | 'company' | 'profile_url' | 'contact'> = ['name', 'company']
      if (title) supports.push('title')
      if (profileUrl) supports.push('profile_url')

      drafts.push({
        fullName: name,
        rawTitle: title,
        statedCompany: company.name,
        profileUrl,
        providerPersonId: null,
        // Company-level email and phone are NOT attributed to an individual:
        // info@company.com is not this person's address, and claiming it were
        // would be exactly the kind of guess this stage prohibits.
        email: null,
        phone: null,
        location: null,
        evidence: [
          {
            provider: this.name,
            sourceType: 'crm_record',
            sourceUrl: null,
            snippet:
              `NXT Sales company ${company.id} ("${company.name}") — contactPersons entry: "${raw}"` +
              (profileUrl ? ` | linkedProfiles entry matching this name: ${profileUrl}` : ''),
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
        withTitle: drafts.filter((d) => d.rawTitle).length,
        unusableEntries: unnamed,
      },
    }
  }
}
