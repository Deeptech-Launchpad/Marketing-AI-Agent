import { htmlToText } from '../../research/htmlToText.js'
import { fetchPage } from '../../research/pageFetch.js'
import { normalizeUrl } from '../../research/ssrfGuard.js'
import { resolveCompanySource } from '../../crm/companySource.js'
import type { IntentSignalDraft } from '../types.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE C (second provider) — the company's OWN careers page.
//
// This exists alongside the Apify job-board provider rather than instead of it,
// and it is deliberately first-class: by the confidence model in this stage, an
// official company page is HIGH-quality evidence while a third-party board is
// MEDIUM. It is also free, and it uses the SSRF-guarded fetcher already built
// for Stage 2.
//
// It is not a crawler. It tries a small fixed set of conventional paths on the
// company's own domain and stops at the first that responds. Anything it reads
// is UNTRUSTED page text used purely as evidence.

const CAREERS_PATHS = ['/careers', '/jobs', '/careers/', '/about/careers', '/company/careers']

const RELEVANT_ROLE_PATTERNS: Array<{ pattern: RegExp; role: string }> = [
  { pattern: /\bproduct data\b/i, role: 'Product Data' },
  { pattern: /\bproduct information\b|\bpim\b/i, role: 'Product Information / PIM' },
  { pattern: /\bcatalog(ue)?\s*(manager|specialist|coordinator|analyst|operations)/i, role: 'Catalog Operations' },
  { pattern: /\bmaster data\b|\bmdm\b/i, role: 'Master Data' },
  { pattern: /\b(e-?commerce)\s*(manager|data|content|catalog(ue)?)/i, role: 'Ecommerce Data' },
  { pattern: /\bmerchandis(ing|er)\b/i, role: 'Merchandising' },
  { pattern: /\b(erp)\s*(manager|analyst|specialist)/i, role: 'ERP' },
]

/** The line the phrase appeared on, so the evidence is quotable. */
function lineContaining(text: string, pattern: RegExp): string | null {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.length >= 4 && t.length <= 200 && pattern.test(t)) return t
  }
  return null
}

const bareHost = (h: string): string => h.toLowerCase().replace(/^www\./, '')

const NOT_FOUND_PATH = /(^|\/)(404|not[-_]?found|page[-_]?not[-_]?found|error)(\/|\.html?|$)/i
const NOT_FOUND_TITLE = /\b(404|not found|page not found|page cannot be found|error)\b/i
const SOFT_404_TEXT =
  /\b(page (?:you (?:are|were) looking for|you requested) (?:(?:could|can) ?not be found|(?:does not|doesn'?t) exist|(?:is|was) not found|has been (?:moved|removed))|404 (?:error|not found|page)|error 404|page not found|nothing (?:was )?found (?:here|at this location)|oops!? (?:that|this) page)\b/i

/**
 * Why a page that answered 200 is still not this company's careers page, or
 * null when it is acceptable.
 *
 * Seen live: a site that serves its 404 template at /404 with status 200, and a
 * website field that pointed to a social platform whose /jobs is the
 * platform's own careers site. Neither says anything about the company hiring.
 */
export function rejectCareersPage(input: {
  requestedBase: URL
  finalUrl: string
  title: string | null
  text: string
}): string | null {
  let final: URL
  try {
    final = new URL(input.finalUrl)
  } catch {
    return 'The final URL could not be read.'
  }
  const wanted = bareHost(input.requestedBase.hostname)
  const got = bareHost(final.hostname)
  if (got !== wanted && !got.endsWith(`.${wanted}`)) {
    return `Redirected off the company site to ${final.hostname}.`
  }
  if (NOT_FOUND_PATH.test(final.pathname)) return `Redirected to an error path (${final.pathname}).`
  if (input.title && NOT_FOUND_TITLE.test(input.title)) return `The page title reads "${input.title.slice(0, 80)}".`
  // Soft 404: the template's wording, near the top of the page.
  if (SOFT_404_TEXT.test(input.text.slice(0, 3000))) return 'The page content is a "not found" template.'
  return null
}

export class CareersPageProvider implements IntentProvider {
  readonly name = 'careers_page'
  readonly category = 'hiring'

  available(): { ok: boolean; reason?: string } {
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const company = ctx.company

    // The one authority on what this company's website is. The raw domain
    // column can hold a social platform ("facebook.com"), and reading
    // /jobs on that is reading Facebook's careers page, not the company's.
    const source = resolveCompanySource(company)
    if (!source.websiteUrl) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: source.reason
          ? `No company website to look for a careers page on: ${source.reason}`
          : 'No domain on the CRM record, so no careers page could be located.',
        durationMs: Date.now() - started,
        // A gap in the record, not a failure of this run.
        metadata: { notApplicable: true },
      }
    }

    const base = normalizeUrl(source.websiteUrl)
    if (!base) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: `Stored website "${source.websiteUrl}" is not a usable http(s) URL.`,
        durationMs: Date.now() - started,
        metadata: { notApplicable: true },
      }
    }

    const attempted: string[] = []
    const rejected: Array<{ url: string; reason: string }> = []
    let hit: { url: string; text: string } | null = null

    for (const path of CAREERS_PATHS) {
      const target = new URL(path, base).toString()
      attempted.push(target)
      // fetchPage resolves ok:false rather than throwing, so a 404 on one path
      // just moves to the next.
      const page = await fetchPage(target, { tenantId: ctx.tenantId, runId: null })
      if (!page.ok || !page.text || page.text.length <= 200) continue
      const finalUrl = page.finalUrl ?? target
      const refusal = rejectCareersPage({
        requestedBase: base,
        finalUrl,
        title: page.signals?.title ?? null,
        text: page.text,
      })
      if (refusal) {
        rejected.push({ url: finalUrl, reason: refusal })
        continue
      }
      hit = { url: finalUrl, text: page.text }
      break
    }

    if (!hit) {
      // Looking and finding none is an outcome, not a failure to look.
      return {
        provider: this.name,
        ok: true,
        signals: [],
        reason:
          `No careers page found on ${base.hostname}: ${attempted.length} conventional path(s) tried` +
          (rejected.length ? `, ${rejected.length} answered with a page that was not a careers page on this site.` : '.'),
        durationMs: Date.now() - started,
        metadata: { attempted, rejected, careersPageFound: false },
      }
    }

    const text = htmlToText(hit.text)
    const signals: IntentSignalDraft[] = []
    const seen = new Set<string>()

    for (const { pattern, role } of RELEVANT_ROLE_PATTERNS) {
      const line = lineContaining(text, pattern)
      if (!line || seen.has(role)) continue
      seen.add(role)

      signals.push({
        crmCompanyId: company.id,
        signalType: 'careers_page_role',
        signalCategory: 'hiring',
        summary: `Careers page mentions a ${role} role`,
        interpretation:
          `The company's own careers page references ${role} work, indicating it is staffing or planning to staff product/catalog data operations. ` +
          'It does not establish a need for any particular service.',
        // Quoted verbatim from the page: inspectable without re-fetching.
        evidence: `On ${hit.url}: "${line}"`,
        sourceUrl: hit.url,
        sourceType: 'company_website',
        // Careers pages rarely date their listings. Left null rather than
        // guessed — an undated signal is demoted, which is the honest outcome.
        observedAt: null,
        polarity: 'positive',
        provider: this.name,
        metadata: { role, pageUrl: hit.url },
      })
    }

    return {
      provider: this.name,
      ok: true,
      signals,
      durationMs: Date.now() - started,
      metadata: { careersUrl: hit.url, pathsTried: attempted.length, textLength: text.length },
    }
  }
}
