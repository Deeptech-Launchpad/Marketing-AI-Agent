import { htmlToText } from '../../research/htmlToText.js'
import { fetchPage } from '../../research/pageFetch.js'
import { normalizeUrl } from '../../research/ssrfGuard.js'
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

export class CareersPageProvider implements IntentProvider {
  readonly name = 'careers_page'
  readonly category = 'hiring'

  available(): { ok: boolean; reason?: string } {
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const company = ctx.company

    if (!company.domain) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: 'No domain on the CRM record, so no careers page could be located.',
        durationMs: Date.now() - started,
      }
    }

    const base = normalizeUrl(company.domain)
    if (!base) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: `Stored domain "${company.domain}" is not a usable http(s) URL.`,
        durationMs: Date.now() - started,
      }
    }

    const attempted: string[] = []
    let hit: { url: string; text: string } | null = null

    for (const path of CAREERS_PATHS) {
      const target = new URL(path, base).toString()
      attempted.push(target)
      // fetchPage resolves ok:false rather than throwing, so a 404 on one path
      // just moves to the next.
      const page = await fetchPage(target, { tenantId: ctx.tenantId, runId: null })
      if (page.ok && page.text && page.text.length > 200) {
        hit = { url: page.finalUrl ?? target, text: page.text }
        break
      }
    }

    if (!hit) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason: `No careers page responded at any conventional path (${attempted.length} tried).`,
        durationMs: Date.now() - started,
        metadata: { attempted },
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
