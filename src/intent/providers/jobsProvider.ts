import { env } from '../../config/env.js'
import { apifyAvailable, runActor, runCost } from '../apifyClient.js'
import type { IntentSignalDraft } from '../types.js'
import { JOB_BOARDS, boardsFor, normalizeCountry } from '../jobBoards.js'
import type { IntentProvider, ProviderContext, ProviderResult } from './provider.js'

// SOURCE C — HIRING SIGNALS, via a collection provider (Apify).
//
// Apify collects EVIDENCE. It does not decide whether a posting indicates
// intent, and it never produces a score: the roles below are matched by an
// explicit list, and confidence is applied afterwards by the engine's own
// rules. Swapping Actor or provider changes this file and nothing else.
//
// "Do NOT assume every job posting indicates intent" is enforced literally: a
// posting is only turned into a signal when its title matches a role that
// plausibly owns product/catalog data. Everything else is counted and
// discarded, and the discard count is reported.

/**
 * Roles that would own or fund product-data work. Matched as whole phrases
 * against a normalised title, so "product manager" does not match "product data
 * manager" by accident and vice versa.
 */
const RELEVANT_ROLE_PATTERNS: Array<{ pattern: RegExp; role: string }> = [
  { pattern: /\bproduct data\b/i, role: 'Product Data' },
  { pattern: /\bproduct information\b|\bpim\b/i, role: 'Product Information / PIM' },
  { pattern: /\bcatalog(ue)?\s*(manager|specialist|coordinator|analyst|operations|admin)/i, role: 'Catalog Operations' },
  { pattern: /\b(e-?commerce)\s*(data|content|catalog(ue)?|merchandis)/i, role: 'Ecommerce Data / Merchandising' },
  { pattern: /\bmaster data\b|\bmdm\b/i, role: 'Master Data' },
  { pattern: /\bdata (steward|governance)\b/i, role: 'Data Governance' },
  { pattern: /\b(erp)\s*(manager|analyst|specialist|implementation)/i, role: 'ERP' },
  { pattern: /\bmerchandis(ing|er)\b/i, role: 'Merchandising' },
]

function matchRole(title: string): string | null {
  for (const { pattern, role } of RELEVANT_ROLE_PATTERNS) {
    if (pattern.test(title)) return role
  }
  return null
}

/** Shape varies by Actor; only these fields are relied on, all optional. */
interface RawJob {
  positionName?: string
  title?: string
  company?: string
  companyName?: string
  url?: string
  jobUrl?: string
  postedAt?: string
  postingDateParsed?: string
  date?: string
  location?: string
  description?: string
}

function parseDate(raw: RawJob): Date | null {
  const candidate = raw.postingDateParsed ?? raw.date ?? raw.postedAt
  if (!candidate) return null

  // Some boards give "30+ days ago" / "5 days ago" rather than a date.
  const rel = String(candidate).match(/(\d+)\+?\s*days?\s*ago/i)
  if (rel?.[1]) return new Date(Date.now() - Number(rel[1]) * 86_400_000)

  const d = new Date(candidate)
  return Number.isNaN(d.getTime()) ? null : d
}

export class ApifyJobsProvider implements IntentProvider {
  readonly name = 'apify_jobs'
  readonly category = 'hiring'

  available(): { ok: boolean; reason?: string } {
    const a = apifyAvailable()
    if (!a.ok) return a

    // The company's country is not known here, so this asks the weaker
    // question: is ANY board collectable at all? Which boards apply to a
    // given company is decided per company in collect(), because a board that
    // does not serve their country is not a gap to report.
    const collectable = JOB_BOARDS.filter(
      (b) => !b.policyBlock && ((env as unknown as Record<string, string>)[b.actorEnvKey] ?? '') !== '',
    )
    if (!collectable.length) {
      const blocked = JOB_BOARDS.filter((b) => b.policyBlock).map((b) => b.name)
      return {
        ok: false,
        reason:
          `No job board collector is configured. The approved sources are ${JOB_BOARDS.map((b) => b.name).join(', ')}; ` +
          `set the matching Actor variable for at least one of them. ` +
          `${blocked.join(' and ')} additionally requires official API access and cannot be collected by scraping.`,
      }
    }

    // Refuse to spend on an Actor that cannot answer the question being asked.
    // Verified against misceres~indeed-scraper: `company` is not a declared
    // input and is silently ignored, so results come back from arbitrary
    // employers and are then discarded by the employer filter below. That is a
    // per-listing charge for a guaranteed-zero result, so the provider reports
    // itself unavailable instead of running.
    if (!env.APIFY_JOBS_COMPANY_SCOPED) {
      return {
        ok: false,
        reason:
          `Actor "${env.APIFY_JOBS_ACTOR}" cannot scope a search to a single company ` +
          '(no "company" input), so per-prospect hiring signals are not obtainable from it. ' +
          'Set APIFY_JOBS_COMPANY_SCOPED=true only with an Actor that supports company scoping.',
      }
    }
    return { ok: true }
  }

  async collect(ctx: ProviderContext): Promise<ProviderResult> {
    const started = Date.now()
    const company = ctx.company

    // Region-based sourcing (Team Answer, D.1): only the boards that actually
    // serve this company's country are called. Searching Seek for a South
    // African distributor would be a charge with a guaranteed-zero result.
    const country = normalizeCountry(company.country)
    const applicable = boardsFor(country)

    // maxItems is the cost control: these Actors bill per returned listing.
    // The budget is per company, so it is divided across the boards actually
    // being called rather than spent once per board.
    const runnable = applicable.filter((b) => b.availability.status === 'available')
    const perBoard = Math.max(
      5,
      Math.floor(Math.min(ctx.maxResults, env.APIFY_MAX_RESULTS_PER_COMPANY) / Math.max(1, runnable.length)),
    )

    const signals: IntentSignalDraft[] = []
    let irrelevant = 0
    let wrongCompany = 0
    let costUsd: number | undefined
    let listingsReturned = 0
    const boardOutcomes: Array<{ board: string; status: string; reason?: string; listings?: number }> = []

    for (const { board, availability } of applicable) {
      if (availability.status !== 'available') {
        // Recorded, never silently dropped. A board we could not call is not
        // a board that reported no hiring.
        boardOutcomes.push({ board: board.id, status: availability.status, reason: availability.reason })
        continue
      }

      const result = await runActor<RawJob>(
        availability.actorId,
        {
          position: 'product data',
          country: country ?? 'US',
          // Company name scopes the search; without it the Actor returns the
          // whole board, which is both useless and billable.
          company: company.name,
          maxItems: perBoard,
          parseCompanyDetails: false,
          saveOnlyUniqueItems: true,
        },
        { maxItems: perBoard },
      )

      if (result.runId) {
        const c = await runCost(result.runId)
        if (c != null) costUsd = (costUsd ?? 0) + c
      }

      if (!result.ok) {
        // One dead board must not lose what the others found.
        boardOutcomes.push({ board: board.id, status: 'error', reason: result.reason })
        continue
      }

      listingsReturned += result.items.length
      boardOutcomes.push({ board: board.id, status: 'collected', listings: result.items.length })

      for (const raw of result.items) {
        this.ingest(raw, board.id, availability.actorId, result.runId, company, signals, (kind) => {
          if (kind === 'irrelevant') irrelevant++
          else wrongCompany++
        })
      }
    }

    if (!runnable.length) {
      return {
        provider: this.name,
        ok: false,
        signals: [],
        reason:
          `No job board could be collected for ${company.name} (${country ?? 'country not stated'}). ` +
          boardOutcomes.map((b) => `${b.board}: ${b.status}`).join('; '),
        durationMs: Date.now() - started,
        // No board serving this country is configured or permitted. That is a
        // configuration fact, not a failure of this run.
        metadata: { country, boards: boardOutcomes, notConfigured: true },
      }
    }

    return {
      provider: this.name,
      ok: true,
      signals,
      durationMs: Date.now() - started,
      costUsd,
      metadata: {
        country,
        boards: boardOutcomes,
        listingsReturned,
        // Reported so a low signal count is visibly a filtering decision rather
        // than a collection failure.
        discardedIrrelevantRole: irrelevant,
        discardedWrongEmployer: wrongCompany,
      },
    }
  }

  /** Turns one raw listing into a signal, or counts why it was discarded. */
  private ingest(
    raw: RawJob,
    boardId: string,
    actorId: string,
    runId: string | undefined,
    company: ProviderContext['company'],
    signals: IntentSignalDraft[],
    discard: (kind: 'irrelevant' | 'wrong_company') => void,
  ): void {
    {
      const title = (raw.positionName ?? raw.title ?? '').trim()
      const employer = (raw.company ?? raw.companyName ?? '').trim()
      if (!title) return

      // The board matches loosely; a posting from a different employer is not
      // evidence about this prospect.
      if (employer && !namesOverlap(employer, company.name)) {
        discard('wrong_company')
        return
      }

      const role = matchRole(title)
      if (!role) {
        discard('irrelevant')
        return
      }

      const url = raw.jobUrl ?? raw.url ?? null
      const observedAt = parseDate(raw)

      signals.push({
        crmCompanyId: company.id,
        signalType: 'relevant_job_posting',
        signalCategory: 'hiring',
        summary: `Hiring: "${title}"${raw.location ? ` (${raw.location})` : ''}`,
        interpretation:
          `A ${role} role suggests the company is investing in product/catalog data operations, ` +
          'which implies both a budget and an internal owner for that work. It does not establish a need for any particular service.',
        evidence: [
          `Job title: ${title}`,
          employer ? `Employer as listed: ${employer}` : null,
          observedAt ? `Posted: ${observedAt.toISOString().slice(0, 10)}` : 'Posting date: not provided by source',
          url ? `URL: ${url}` : 'URL: not provided by source',
        ]
          .filter(Boolean)
          .join(' | '),
        sourceUrl: url,
        sourceType: 'job_board',
        observedAt,
        polarity: 'positive',
        provider: this.name,
        metadata: { role, board: boardId, actor: actorId, runId, location: raw.location ?? null },
      })
    }
  }
}

/**
 * Job boards write employer names loosely ("Acme Ltd" vs "Acme Limited"). A
 * shared significant token is enough to accept; nothing shared means the
 * posting belongs to someone else.
 */
function namesOverlap(a: string, b: string): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/\b(ltd|limited|inc|llc|corp|corporation|co|company|plc|gmbh|group|holdings)\b/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((t) => t.length > 2)

  const A = new Set(norm(a))
  const B = norm(b)
  return B.some((t) => A.has(t))
}
