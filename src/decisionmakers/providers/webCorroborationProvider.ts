import { createHash } from 'node:crypto'
import { env } from '../../config/env.js'
import { fetchPage } from '../../research/pageFetch.js'
import { hostOf } from '../companyMatch.js'
import { TEAM_PAGE_PATHS, extractPeople } from '../peopleExtraction.js'
import type { CandidateDraft, ProviderStatus } from '../types.js'
import type { DecisionMakerProvider, DmProviderContext, DmProviderResult } from './provider.js'

// SOURCE — the company's own leadership / team / about pages.
//
// This is the only Stage 4 source that actually runs in this environment, and
// it is also the best one available on the merits: a company publishing "Jane
// Smith, VP of Ecommerce" on its own website is the authority on its own staff.
// It is the same reasoning Stage 2 uses to treat a <meta generator> tag as HIGH
// confidence — first-party declarations outrank third-party inference.
//
// Its limits, stated plainly rather than papered over:
//   - Most distributors publish executives only, or nobody at all. A Product
//     Data Manager is almost never on a leadership page.
//   - Pages are read through the existing SSRF-guarded fetcher, honouring the
//     same timeouts, redirect limits and byte caps as the rest of the service.
//   - Extraction is regex-based and precision-biased. It misses people. That is
//     the correct trade when the alternative is inventing them.
//
// The fetched text is UNTRUSTED and never reaches a model. No page content can
// select a tool, change a permission, or trigger a write.

export class WebCorroborationProvider implements DecisionMakerProvider {
  readonly name = 'company_website'
  readonly sourceType = 'company_website'

  available(ctx?: DmProviderContext): { status: ProviderStatus; reason?: string } {
    if (ctx && !ctx.companyDomain) {
      return {
        status: 'unavailable',
        reason:
          'No verified website domain is known for this company, so there is no first-party site to read. ' +
          'Run Stage 2 enrichment first, or record a domain on the CRM record.',
      }
    }
    return { status: 'available' }
  }

  async search(ctx: DmProviderContext): Promise<DmProviderResult> {
    const started = Date.now()
    const host = hostOf(ctx.companyDomain)
    if (!host) {
      return {
        provider: this.name,
        status: 'unavailable',
        candidates: [],
        reason: `"${ctx.companyDomain}" is not a usable hostname.`,
        durationMs: Date.now() - started,
      }
    }

    const drafts: CandidateDraft[] = []
    const pagesTried: Array<{ url: string; ok: boolean; people: number; duplicateOf?: string; reason?: string }> = []
    const seenNames = new Set<string>()
    // Content hash -> the first URL that returned it.
    const seenContent = new Map<string, string>()

    const budget = Math.min(env.DM_MAX_PAGES_PER_COMPANY, TEAM_PAGE_PATHS.length)

    for (const path of TEAM_PAGE_PATHS.slice(0, budget)) {
      if (drafts.length >= ctx.maxResults) break

      const url = `https://${host}${path}`
      const page = await fetchPage(url, { tenantId: ctx.tenantId })

      if (!page.ok || !page.text) {
        // A missing /leadership is the normal case, not an error worth failing on.
        pagesTried.push({ url, ok: false, people: 0, reason: page.reason })
        continue
      }

      // Soft 404s. Plenty of sites answer 200 for any path and serve the
      // homepage or a generic not-found page: 4kbm.com returned byte-identical
      // content for all eight paths tried. Counting those as eight readable
      // team pages would make "reachable" mean "the server answered", and turn
      // a site with no team page into one that appears to list nobody.
      const fingerprint = createHash('sha256').update(page.text).digest('hex')
      const firstSeenAt = seenContent.get(fingerprint)
      if (firstSeenAt) {
        pagesTried.push({ url, ok: true, people: 0, duplicateOf: firstSeenAt })
        continue
      }
      seenContent.set(fingerprint, url)

      const people = extractPeople(page.text)
      pagesTried.push({ url, ok: true, people: people.length })

      for (const person of people) {
        const key = person.name.toLowerCase()
        if (seenNames.has(key)) continue
        seenNames.add(key)

        drafts.push({
          fullName: person.name,
          rawTitle: person.title,
          // The company IS the source, so the employer is established by the
          // fact of publication rather than by a string the page contains.
          statedCompany: ctx.company.name,
          profileUrl: null,
          providerPersonId: null,
          // No contact details are read from these pages. A page may list an
          // email next to a name; this stage does not need it, so it is not
          // collected. See DM_STORE_CONTACT_DATA.
          email: null,
          phone: null,
          location: null,
          evidence: [
            {
              provider: this.name,
              sourceType: 'company_website',
              sourceUrl: page.finalUrl ?? url,
              // The literal text off the page, so the claim can be re-checked
              // by a human against the live page.
              snippet: person.snippet.slice(0, 500),
              // Pages rarely date their staff listings, and stamping "now"
              // would assert the listing is current when only the fetch is.
              observedAt: null,
              supports: ['name', 'title', 'company'],
            },
          ],
        })

        if (drafts.length >= ctx.maxResults) break
      }
    }

    const answered = pagesTried.filter((p) => p.ok)
    const distinct = answered.filter((p) => !p.duplicateOf)
    const duplicates = answered.length - distinct.length

    return {
      provider: this.name,
      status: drafts.length ? 'available' : 'no_results',
      candidates: drafts,
      reason: drafts.length
        ? undefined
        : !answered.length
          ? `None of the ${pagesTried.length} standard team-page paths on ${host} could be reached.`
          : duplicates && distinct.length <= 1
            ? `${host} returned identical content for ${answered.length} different paths, so it serves the same page ` +
              'for any URL and has no team or leadership page to read.'
            : `Read ${distinct.length} distinct page(s) on ${host}` +
              (duplicates ? ` (${duplicates} further path(s) returned content already seen)` : '') +
              '; none listed a person alongside a job title.',
      durationMs: Date.now() - started,
      metadata: { host, pagesTried, distinctPages: distinct.length, duplicatePages: duplicates },
    }
  }
}
