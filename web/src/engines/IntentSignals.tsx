import { useEffect } from 'react'
import { api } from '../lib/api'
import { useEngineAction, usePolling, useResource } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import { checkLineage, checkRowLineage, firstMismatch } from '../lib/auditLineage'
import { Clock, Radar } from 'lucide-react'
import { useEngine, EnginePage, EngineSplit, type EngineCompletion } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, Button, Unset, Field, StatusBadge } from '../components/ui/primitives'
import { BlockedState, EmptyState, ErrorState, LineageMismatch, LoadingState } from '../components/ui/states'
import { SignalWave } from '../components/motion/Signatures'
import { EvidenceButton, type EvidenceItem } from '../components/ui/Evidence'
import type { IntentSignal, UiStatus } from '../lib/types'
import './intent.css'

// Intent Signals (#977).
//
// Signals come from the CRM, careers pages and job boards. Each carries the
// source that produced it and a confidence the backend assigned — the
// interface reports both and computes neither.
//
// Nothing on this screen is interpreted here. The significance of a signal is
// the detector's own `interpretation` column, shown verbatim; a reading
// composed in the browser from a signal's name would be a claim no source ever
// made, which is the one thing this engine must never produce.
//
// WHAT THE SCREEN SAYS ABOUT THE RUN
//
// It used to read the signals list alone and print "Signals detected: 0" for
// every company that had none — which was the same sentence for a company
// nobody had run detection on, a company whose run was still queued behind a
// worker that was not running (the worker is a separate process, src/worker.ts,
// and every click enqueued a job nothing consumed), a company the providers
// had searched and found nothing at, and a run that had failed. Only one of
// those is a finding about the company.
//
// The run is now read from the backend's own row and its status is said in
// the platform's words: NOT RUN / QUEUED / RUNNING / COMPLETED / PARTIAL /
// BLOCKED / FAILED. Nothing on this screen derives a status the backend did
// not record: PARTIAL and BLOCKED are the run's own providerResults read back
// (a provider that could not run is stored as ok:false with its reason), and
// "status unknown" is what a request failure says rather than a zero.

/**
 * What the signals endpoint actually returns.
 *
 * The route hands back the stored row wholesale, so every column of the model
 * arrives with it. The shared type carries only the columns the old table
 * read, and explaining a signal needs the rest of them — the interpretation,
 * the literal evidence, the source it came from and the reasons behind the
 * confidence grade.
 */
interface DetectedSignal extends Omit<IntentSignal, 'evidence'> {
  /** WHY the detector says this may indicate a need. Never our own words. */
  interpretation?: string | null
  /** How a seller could open on this. Null is common and shows nothing. */
  outreachAngle?: string | null
  /** The literal thing observed: a job title, a meta tag, a CRM row. */
  evidence?: string | null
  sourceType?: string | null
  provider?: string | null
  /** When the SOURCE says the event happened. Null when it does not say. */
  observedAt?: string | null
  ageDays?: number | null
  freshness?: string | null
  confidenceReasons?: string[] | null
  polarity?: string | null
  /** Other sources describing the same event, as recorded strings. */
  corroboratingEvidence?: unknown
  /** The run that recorded it. Signals persist per run, so a company's list spans runs. */
  intentRunId?: string | null
  /** Which company the row belongs to — checked, never assumed. */
  crmCompanyId?: string | null
  /** Provider-specific facts. Read defensively: it is a Json column. */
  metadata?: unknown
}

/** One row of GET /intent/runs — the columns that route selects, and no more. */
interface IntentRunRow {
  id: string
  crmCompanyId: string
  companyName: string | null
  /** queued | running | completed | failed, as the engine wrote it. */
  status: string
  signalCount: number
  duplicatesCollapsed: number
  costUsd: string | number
  failureReason: string | null
  createdAt: string
  completedAt: string | null
}

/**
 * GET /intent/runs/:id — the whole row. `providerResults` is the part that
 * matters here: it is the run's own record of which sources actually ran, and
 * a run that "completed" with the job board unavailable is not the same
 * finding as one where every source was read.
 */
interface IntentRunDetail extends IntentRunRow {
  startedAt?: string | null
  providerResults?: unknown
  retryCount?: number
}

/** One entry of providerResults, as intentDetection.ts stores it. */
interface ProviderOutcome {
  provider: string
  ok: boolean
  signals: number
  reason: string | null
  /** Provider facts. `notConfigured` / `notApplicable` mark expected non-runs. */
  metadata?: { notConfigured?: boolean; notApplicable?: boolean } | null
}

/**
 * How one provider's outcome reads.
 *
 *   ran           — it looked (with or without findings)
 *   notConfigured — switched off by configuration; not a failure of the run
 *   notApplicable — the record gave it nothing to read (no website, no name)
 *   failed        — it tried and could not: the only kind that makes a run PARTIAL
 */
type OutcomeKind = 'ran' | 'notConfigured' | 'notApplicable' | 'failed'

function outcomeKind(p: ProviderOutcome): OutcomeKind {
  if (p.ok) return 'ran'
  if (p.metadata?.notConfigured) return 'notConfigured'
  if (p.metadata?.notApplicable) return 'notApplicable'
  return 'failed'
}

/** The words shown after a provider's name. Always separated by real spaces. */
function outcomeText(p: ProviderOutcome): string {
  switch (outcomeKind(p)) {
    case 'ran':
      return p.signals > 0
        ? `${p.signals} signal${p.signals === 1 ? '' : 's'}`
        : `looked, found none${p.reason ? ` — ${p.reason}` : ''}`
    case 'notConfigured':
      return `not configured — ${p.reason ?? 'no reason recorded'}`
    case 'notApplicable':
      return `not applicable — ${p.reason ?? 'no reason recorded'}`
    case 'failed':
      return `could not run — ${p.reason ?? 'no reason recorded'}`
  }
}

/**
 * The observation that overtook a signal, when one did.
 *
 * Written by the engine onto the expired row as `metadata.supersededBy`, so
 * the screen reports a withdrawal rather than inferring one.
 */
function supersededNote(signal: { metadata?: unknown }): string | null {
  const meta = signal.metadata as { supersededBy?: { reason?: string } } | null | undefined
  const reason = meta?.supersededBy?.reason
  return typeof reason === 'string' && reason.trim() ? reason : null
}

/**
 * How many distinct places the evidence came from.
 *
 * A platform where the provider named one, and the signal's own source type
 * otherwise — so the company website and the CRM each count once, and five
 * social platforms count five.
 */
function distinctSources(rows: Array<{ metadata?: unknown; sourceType?: string | null; signalCategory: string }>): number {
  const seen = new Set<string>()
  for (const r of rows) seen.add(platformLabel(r) ?? r.sourceType ?? r.signalCategory)
  return seen.size
}

/** The platform a signal came from, when the provider recorded one. */
function platformLabel(signal: { metadata?: unknown }): string | null {
  const meta = signal.metadata as { platformLabel?: string; platform?: string } | null | undefined
  const label = meta?.platformLabel ?? meta?.platform
  if (typeof label !== 'string' || !label.trim()) return null
  return label.length <= 3 ? label.toUpperCase() : label.charAt(0).toUpperCase() + label.slice(1)
}

/**
 * How each platform answered, read from the social provider's own result.
 *
 * `blocked` and `login_required` are warnings rather than errors: nothing
 * failed, a platform declined to serve a logged-out reader, and that is a
 * finding about the platform rather than about the company.
 */
const ACCESS_TONE: Record<string, 'ok' | 'warn' | 'neutral' | 'danger'> = {
  public: 'ok',
  metadata_only: 'ok',
  login_required: 'warn',
  consent_required: 'warn',
  blocked: 'warn',
  not_found: 'neutral',
  unreachable: 'neutral',
}

interface SourceAccess {
  url: string
  platform: string
  access: string
  note: string
}

function readSourceAccess(providerResults: unknown): SourceAccess[] {
  if (!Array.isArray(providerResults)) return []
  const out: SourceAccess[] = []
  for (const r of providerResults as Array<{ metadata?: { access?: unknown } }>) {
    const access = r?.metadata?.access
    if (!Array.isArray(access)) continue
    for (const a of access as SourceAccess[]) {
      if (a && typeof a.url === 'string' && typeof a.platform === 'string' && !out.some((x) => x.url === a.url)) {
        out.push(a)
      }
    }
  }
  return out
}

/** The vocabulary the run status is spoken in, everywhere it applies. */
type RunWord = 'NOT RUN' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'BLOCKED' | 'FAILED' | 'STATUS UNKNOWN'

/**
 * A queued run that nothing has picked up for this long is almost certainly
 * waiting on a worker that is not running: pg-boss hands a job to a live
 * worker within seconds. Past this the screen says so, rather than letting
 * "queued" read as progress indefinitely.
 */
const WORKER_SUSPECT_AFTER_MS = 30_000

// Type names are snake_cased at the source and drawn from a closed set
// (`pim_erp_detected`, `careers_page_role`), so spacing and casing is the only
// thing done to them. Nothing is renamed: an unrecognised type still reads as
// itself rather than falling back to a friendlier word for something else.
const ACRONYMS = new Set(['crm', 'pim', 'erp', 'rfp'])

const PLATFORM_LABELS: Record<string, string> = {
  linkedin: 'LinkedIn',
  facebook: 'Facebook',
  instagram: 'Instagram',
  x: 'X (Twitter)',
  youtube: 'YouTube',
}

/**
 * The social detector names its types by platform, which the generic
 * word-splitter turns into "Social presence linkedin" — a machine's
 * description of its own row rather than a title anyone would write. Those
 * shapes get a heading a person would recognise; everything else falls through
 * to the generic path.
 */
const SOCIAL_TITLES: Array<{ prefix: string; title: (platform: string) => string }> = [
  { prefix: 'social_presence_', title: (p) => `${p} profile detected` },
  { prefix: 'social_description_', title: (p) => `${p} profile description` },
]

/** What a recent social post was about (src/intent/socialActivity.ts POST_KIND_INFO). */
const ACTIVITY_LABELS: Record<string, string> = {
  product_launch: 'New product launch',
  product_promotion: 'Product promotion',
  catalog_update: 'Catalogue update',
  ecommerce_or_website: 'Website or online-store change',
  ai_or_technology: 'AI or technology adoption',
  product_data_issue: 'Product-data problem',
  expansion: 'Expansion',
  partnership: 'New brand or partnership',
  event: 'Event',
  customer_feedback: 'Customer feedback on a post',
}

function readableType(raw: string): string {
  if (raw.startsWith('social_activity_')) {
    const kind = raw.slice('social_activity_'.length)
    return `${ACTIVITY_LABELS[kind] ?? readableWords(kind)} — recent social post`
  }
  for (const rule of SOCIAL_TITLES) {
    if (raw.startsWith(rule.prefix)) {
      const key = raw.slice(rule.prefix.length)
      return rule.title(PLATFORM_LABELS[key] ?? readableWords(key))
    }
  }
  if (raw.startsWith('social_post_')) {
    // The theme the detector matched, e.g. social_post_new_product_or_range.
    return `${readableWords(raw.slice('social_post_'.length))} mentioned in a public post`
  }
  if (raw === 'personalization_public_interest') return 'Public interest mentioned'
  return readableWords(raw)
}

function readableWords(raw: string): string {
  const words = raw.split('_').filter(Boolean)
  if (!words.length) return raw
  return words
    .map((w, i) => (ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ')
}

/** The five source types the detector records against (src/intent/types.ts). */
const SOURCE_LABELS: Record<string, string> = {
  crm_record: 'CRM record',
  company_website: 'Company website',
  job_board: 'Job board',
  news_article: 'News article',
  third_party: 'Third-party source',
  social_profile: 'Public profile',
}

function sourceLabel(s: DetectedSignal): string {
  const known = SOURCE_LABELS[s.sourceType ?? '']
  if (known) return known
  return s.sourceType ? readableType(s.sourceType) : 'Source not recorded'
}

/**
 * Which platform a signal came from, when it came from one.
 *
 * Read from the row the detector wrote — never guessed from the URL, because a
 * link that merely mentions a platform is not the same as a signal collected
 * from it, and the difference is exactly what a reader is trusting this chip
 * to get right.
 */
function platformOf(s: DetectedSignal): string | null {
  const meta = s.metadata
  if (!meta || typeof meta !== 'object') return null
  const raw = (meta as Record<string, unknown>).platform
  return typeof raw === 'string' ? (PLATFORM_LABELS[raw] ?? raw) : null
}

/** A date a manager can read, rather than the ISO string it arrives as. */
function day(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/** A timestamp with its time of day — a run's lifecycle happens within minutes. */
function clock(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** How long something has been the case, in units a person would say. */
function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ${s % 60} s`
  const h = Math.floor(m / 60)
  return `${h} h ${m % 60} min`
}

/**
 * When the EVENT happened, which is not when we noticed it.
 *
 * Freshness is scored on the source's own date, so a signal the source never
 * dated says exactly that instead of borrowing the detection time. Printing
 * our fetch time as the event date is what makes two-year-old intent look like
 * it happened this morning.
 */
function whenLabel(s: DetectedSignal): string {
  if (s.observedAt) return `Happened ${day(s.observedAt)}`
  return `Source gave no date · detected ${day(s.detectedAt)}`
}

/**
 * The drawer's reading of one signal.
 *
 * `whyItMatters` is the detector's `interpretation` column and nothing else.
 * Where the record holds none, the drawer says so — an absent interpretation
 * is a fact about the record, and filling it in from the signal's name would
 * put words in a source's mouth.
 */
function evidenceFor(s: DetectedSignal): EvidenceItem[] {
  const interpretation = (s.interpretation ?? '').trim()
  const reasons = (s.confidenceReasons ?? []).join(' ')

  const how = [
    `Recorded by the ${s.provider ?? 'unnamed'} provider on ${day(s.detectedAt)}.`,
    reasons ? `Reference graded ${s.confidence}: ${reasons}` : `Reference graded ${s.confidence}.`,
    s.observedAt
      ? `Freshness ${s.freshness ?? 'unknown'}${typeof s.ageDays === 'number' ? `, ${s.ageDays} day${s.ageDays === 1 ? '' : 's'} old` : ''}.`
      : 'The source did not date the event, so its age cannot be established and its confidence was demoted for it.',
  ].join(' ')

  const primary: EvidenceItem = {
    summary: s.summary,
    whyItMatters: interpretation || 'No interpretation was recorded for this signal.',
    // Shown only when the record holds one. A signal whose category suggests
    // no opening shows no angle rather than a generic line — an angle nobody
    // chose reads as advice while carrying none.
    outreachAngle: (s.outreachAngle ?? '').trim() || null,
    source: sourceLabel(s),
    sourceUrl: s.sourceUrl,
    at: s.observedAt ?? null,
    fragment: (s.evidence ?? '').trim() || null,
    how,
    reference: s.id,
  }

  // The same event seen by a second source. Kept as its own observation rather
  // than folded into the first, because corroboration is only worth anything
  // if the reader can see which source said what.
  const corroborating = Array.isArray(s.corroboratingEvidence) ? s.corroboratingEvidence : []

  return [
    primary,
    ...corroborating.map<EvidenceItem>((text) => ({
      what: 'A second source recorded the same event.',
      fragment: String(text),
    })),
  ]
}

/**
 * The run's own per-provider record, read defensively.
 *
 * `providerResults` is a Json column: anything that is not the array
 * intentDetection.ts writes is treated as "not recorded", never as "every
 * provider ran". Missing provider outcomes cannot make a run read as complete.
 */
function providerOutcomes(raw: unknown): ProviderOutcome[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (p): p is ProviderOutcome =>
      Boolean(p) && typeof p === 'object' && typeof (p as ProviderOutcome).provider === 'string' && typeof (p as ProviderOutcome).ok === 'boolean',
  )
}

/**
 * The run's status in the platform's vocabulary.
 *
 * COMPLETED, PARTIAL and BLOCKED are all `status: 'completed'` on the row;
 * they differ only in providerResults, which is why the detail is read at all.
 * A completed run whose job-board provider was unavailable is PARTIAL, and one
 * where no provider could run is BLOCKED — not COMPLETED, because "complete
 * with nothing found" would be reported as a fact about the company when it is
 * a fact about our configuration.
 */
function runWord(run: IntentRunDetail | null, providers: ProviderOutcome[]): RunWord {
  if (!run) return 'NOT RUN'
  const s = (run.status ?? '').toLowerCase()
  if (s === 'queued') return 'QUEUED'
  if (s === 'running') return 'RUNNING'
  if (s === 'failed') return 'FAILED'
  if (s === 'completed') {
    // BLOCKED: nothing looked anywhere. PARTIAL: something tried and FAILED.
    // A provider that is not configured, or had nothing on the record to
    // read, is an expected outcome and does not make a run partial.
    if (providers.length && providers.every((p) => !p.ok)) return 'BLOCKED'
    if (providers.some((p) => outcomeKind(p) === 'failed')) return 'PARTIAL'
    return 'COMPLETED'
  }
  return 'STATUS UNKNOWN'
}

/**
 * The badge tone for each word. QUEUED is drawn STILL, never spinning: a
 * queued run behind a dead worker that pulses reads as progress, and that is
 * the exact impression this screen exists to stop. Only RUNNING moves.
 */
const TONE: Record<RunWord, UiStatus> = {
  'NOT RUN': 'idle',
  QUEUED: 'ready',
  RUNNING: 'running',
  COMPLETED: 'complete',
  PARTIAL: 'blocked',
  BLOCKED: 'blocked',
  FAILED: 'error',
  'STATUS UNKNOWN': 'error',
}

export function IntentSignals() {
  const engine = useEngine('intent')
  const { company } = useCompany()
  const { can } = useAuth()
  const id = company?.crmCompanyId
  const name = company?.companyName ?? 'this company'

  const signals = useResource<{ signals: DetectedSignal[]; disclaimers?: string[] }>(
    (signal) => api.resource(`/intent/companies/${id}/signals`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )

  // The run list is tenant-wide (newest 100) and carries each run's company,
  // so the company's newest run is the first row naming it. Rows naming any
  // other company are filtered here and never drawn.
  const runs = useResource<{ runs: IntentRunRow[] }>(
    (signal) => api.resource('/intent/runs', { signal }),
    [id],
    { enabled: Boolean(id) },
  )

  const rows = signals.data?.signals ?? []
  const latestFromList = id ? (runs.data?.runs ?? []).find((r) => r.crmCompanyId === id) ?? null : null

  // A company whose runs are all older than the newest 100 in the tenant is
  // missing from the list even though its signals exist. Each signal names the
  // run that recorded it, so the newest signal's run stands in — that run
  // exists (the signal is a child of it) and is read by id. Only a READY list
  // takes this path: when the list itself failed, nothing is known, and a
  // guessed run would be a status the backend did not give us.
  const fallbackId = runs.data && !latestFromList ? (rows[0]?.intentRunId ?? null) : null
  const detailId = latestFromList?.id ?? fallbackId

  const detail = useResource<IntentRunDetail>(
    (signal) => api.resource(`/intent/runs/${detailId}`, { signal }),
    [detailId],
    { enabled: Boolean(detailId) },
  )

  // The detail is preferred (it has providerResults) but only while it is the
  // detail OF this run: useResource keeps the last data across a key change,
  // and a freshly queued run must not wear its predecessor's "completed".
  const detailRun = detail.data && detail.data.id === detailId ? detail.data : null
  const run: IntentRunDetail | null = detailRun ?? latestFromList
  const providers = providerOutcomes(detailRun?.providerResults)
  const providersDown = providers.filter((p) => outcomeKind(p) === 'failed')

  // The list could not be read, or answered that it does not exist: then
  // NOT RUN cannot be told from COMPLETED-with-nothing, and the screen says
  // that instead of picking one.
  const listUnreadable = Boolean(runs.error) || Boolean(runs.absent)
  const word: RunWord = listUnreadable && !run ? 'STATUS UNKNOWN' : runWord(run, providers)
  const active = word === 'QUEUED' || word === 'RUNNING'

  // A run moves QUEUED -> RUNNING -> terminal in another process, so the
  // screen re-reads while it is in flight. One timer for all three resources.
  const following = usePolling(
    () => {
      runs.refresh()
      detail.refresh()
      signals.refresh()
    },
    active,
  )

  // How long the run has sat in the queue. Re-rendered by each poll, so the
  // figure moves; a queued row that has waited past the threshold is drawn as
  // waiting on the worker, not as progress.
  const queuedForMs = word === 'QUEUED' && run?.createdAt ? Date.now() - Date.parse(run.createdAt) : 0
  const workerSuspect = word === 'QUEUED' && queuedForMs >= WORKER_SUSPECT_AFTER_MS

  // The endpoint states its own limits. They are shown as it wrote them rather
  // than paraphrased, because a caveat is only binding in the words that
  // carry it.
  const disclaimers = signals.data?.disclaimers ?? []
  const byCategory = rows.reduce<Record<string, number>>((acc, s) => {
    acc[s.signalCategory] = (acc[s.signalCategory] ?? 0) + 1
    return acc
  }, {})

  // Which platforms were reached, and what each one served. Read from the
  // run's own per-provider record, so a wall is reported as a wall.
  const sourceAccess = readSourceAccess(run?.providerResults)

  // The engine's real work, triggered by a person. The endpoint takes a
  // BATCH of company references, so the selected company is sent as a
  // one-element array — the shape the schema accepts. It answers 202 with the
  // queued run; the list is re-read so the new row's QUEUED shows at once.
  // The backend answers with the run already in flight for this company rather
  // than queueing a second one, so a double click cannot start two runs.
  const detect = useEngineAction(async () => {
    if (!id) return
    await api.post('/intent/detect', { crmCompanyIds: [id] })
    runs.refresh()
    detail.refresh()
    signals.refresh()
  })
  // A failed start belongs to the company it happened on (2026-10-06).
  const resetDetect = detect.reset
  useEffect(() => resetDetect(), [id, resetDetect])

  // A second detection while one is queued would only queue a second job
  // behind the same worker, so the action waits for the run in flight.
  const action = can('operate') && id && (
    <Button
      icon={Radar}
      variant="primary"
      onClick={detect.fire}
      busy={detect.running}
      disabled={active || detect.running}
      title={active ? `A run is already ${word.toLowerCase()} for ${name}.` : undefined}
    >
      {word === 'FAILED' || word === 'COMPLETED' || word === 'PARTIAL' || word === 'BLOCKED' ? 'Detect again' : 'Detect signals'}
    </Button>
  )

  // Nothing of another company's run or signals may be drawn. The run is
  // fetched by id, so its company is checked rather than assumed.
  const mismatch = firstMismatch(
    checkLineage('intent detection run', run, id),
    checkRowLineage('intent signal', rows, id),
  )

  const status = word === 'QUEUED' && workerSuspect ? 'blocked' : TONE[word]
  const badgeLabel = word === 'STATUS UNKNOWN' && run?.status ? run.status.toUpperCase() : word

  // Only a terminal run that actually looked somewhere has a count to report.
  // While NOT RUN, QUEUED, RUNNING, FAILED or BLOCKED, a zero would be the
  // old defect back again; the figure is shown when there is one to show or
  // when zero is a genuine finding.
  const countIsFinding = word === 'COMPLETED' || word === 'PARTIAL'
  const showCount = rows.length > 0 || countIsFinding
  const latestRunId = run?.id ?? null

  // What the footer says. The next stage is offered once this one has finished
  // for the company; a failed or blocked run keeps the plain link and states
  // the reason, and never shows a tick.
  const completion: EngineCompletion | undefined =
    word === 'COMPLETED'
      ? {
          done: true,
          label:
            run && run.signalCount > 0
              ? `Intent detection complete — ${run.signalCount} signal${run.signalCount === 1 ? '' : 's'} observed in the latest run`
              : 'Intent detection complete — no qualifying signals observed',
        }
      : word === 'PARTIAL'
        ? {
            done: true,
            label: `Intent detection PARTIAL — ${providersDown.length} of ${providers.length} providers failed (${providersDown.map((p) => readableType(p.provider)).join(', ')})`,
          }
        : word === 'BLOCKED'
          ? {
              done: false,
              blockedReason: `Intent detection is BLOCKED for ${name}: none of the ${providers.length} providers could run — ${providersDown.map((p) => `${readableType(p.provider)}: ${p.reason ?? 'no reason recorded'}`).join('; ')}.`,
            }
          : word === 'FAILED'
            ? {
                done: false,
                blockedReason: `Intent detection FAILED for ${name}: ${run?.failureReason ?? 'the run recorded no reason'}.`,
              }
            : undefined

  // First load only: once anything is on screen, refreshes happen in place.
  const initialLoading = (runs.loading && !runs.state) || (signals.loading && !signals.state)

  return (
    <EnginePage
      engineId="intent"
      state={
        detect.running || active
          ? 'running'
          : word === 'FAILED' || signals.error || runs.error
            ? 'error'
            : countIsFinding
              ? 'success'
              : 'idle'
      }
      signature={<SignalWave accent={engine.accent} />}
      actions={action}
      completion={completion}
    >
      {detect.error && (
        <ErrorState error={detect.error} what="Detection could not be queued" onRetry={detect.fire} />
      )}

      {!company ? (
        <EmptyState title="Select a company" detail="Intent signals are collected per company." />
      ) : mismatch && !mismatch.ok ? (
        <LineageMismatch
          what={mismatch.what}
          expected={mismatch.expected}
          found={mismatch.found}
          onReload={() => {
            runs.refresh()
            detail.refresh()
            signals.refresh()
          }}
        />
      ) : initialLoading ? (
        <LoadingState what="Listening for intent signals" visual={<SignalWave accent={engine.accent} />} />
      ) : (
        <EngineSplit
          main={
            <>
              {/* The run list is what separates "never ran" from "ran and
                  found nothing". Without it neither can be claimed, so the
                  failure is stated first and no count is drawn beneath it. */}
              {runs.error ? (
                <ErrorState
                  error={runs.error}
                  what="The intent detection runs could not be read"
                  affects={`Whether detection has run for ${name} is unknown. This is not "not run", and it is not a count of zero.`}
                  onRetry={runs.refresh}
                />
              ) : runs.absent ? (
                <BlockedState
                  what="Run status unavailable"
                  why={runs.absent}
                  affects={`Whether detection has run for ${name} cannot be established from this answer.`}
                  remediation="Retry, and if it persists quote the sentence above to engineering."
                  action={
                    <Button onClick={runs.refresh} size="sm">
                      Read again
                    </Button>
                  }
                />
              ) : null}

              <Panel
                title="What was detected"
                actions={<StatusBadge status={status} label={badgeLabel} />}
              >
                <div className="viz viz--short">
                  <SignalWave accent={engine.accent} label="Intent signal waveform" />
                </div>

                <RunSentence word={word} run={run} name={name} providers={providers} queuedForMs={queuedForMs} workerSuspect={workerSuspect} />

                {showCount && (
                  <p className="sig-lead" style={{ ['--e' as string]: engine.accent }}>
                    Signals on record (all runs, one per event):{' '}
                    <span className="sig-lead__count tnum">{rows.length}</span>
                  </p>
                )}
                {showCount && run && (word === 'COMPLETED' || word === 'PARTIAL') && (
                  <p className="sig-lead__note">
                    The latest run observed {run.signalCount} of them. An event seen again by a later run is refreshed in
                    place, not counted twice.
                  </p>
                )}
                <p className="sig-lead__note">
                  Intent detection reads the CRM, the company website’s technology, the public profiles the company links
                  to, and the open web, and records only what those sources actually stated. Job postings are not used
                  as intent signals. Each signal is evidence that something happened — not a conclusion that this company needs
                  anything. Scoring is a later stage; nothing here has been scored.
                </p>

                {showCount && (
                  <MetricRow>
                    <Metric label="Still active" value={rows.filter((s) => s.status === 'active').length} accent size="sm" hint="Recent as of today, and referenced" />
                    {/* DISTINCT PLACES THE EVIDENCE CAME FROM, not categories.
                        This counted signal CATEGORIES, so a company with
                        signals from five separate platforms read "Sources 1"
                        because all five are category "business" — directly
                        beside a panel listing all five by name. */}
                    <Metric
                      label="Sources"
                      value={distinctSources(rows)}
                      size="sm"
                      hint="Platforms and systems the evidence came from"
                    />
                    <Metric label="Graded high" value={rows.filter((s) => s.confidence === 'high').length} size="sm" hint="Reference quality, not sales likelihood" />
                  </MetricRow>
                )}
              </Panel>

              <Panel title="Detected signals" subtitle="Newest first. Every card opens the reference behind it.">
                {signals.error ? (
                  // Not "no signals": no answer. The list and its zero are
                  // withheld, because a broken request drawn as an empty
                  // list is a finding about the company that nobody made.
                  <ErrorState
                    error={signals.error}
                    what="This company’s signals could not be read"
                    affects={`Nothing is known about signals for ${name} — in particular, not that there are none.`}
                    onRetry={signals.refresh}
                  />
                ) : signals.absent ? (
                  <EmptyState title="No signals are recorded" detail={signals.absent} />
                ) : rows.length === 0 ? (
                  <NoRows word={word} run={run} name={name} providers={providers} action={action || undefined} />
                ) : (
                  <ol className="siglist">
                    {rows.map((s, i) => (
                      <li key={s.id} className="sig__card node-reveal" style={{ ['--i' as string]: i, ['--e' as string]: engine.accent }}>
                        <div className="sig__head">
                          <span className="sig__name">{readableType(s.signalType)}</span>
                          <Chip tone="accent">{s.signalCategory}</Chip>
                          {/* WHICH PLATFORM SAID IT.
                              The category says "business"; it does not say
                              whether that came from LinkedIn, Facebook or the
                              company's own site. A reader checking a claim
                              needs to know which door to knock on. */}
                          {platformLabel(s) && <Chip tone="info">{platformLabel(s)}</Chip>}
                          <Chip
                            tone={s.confidence === 'high' ? 'ok' : s.confidence === 'medium' ? 'warn' : 'neutral'}
                            title="Confidence grades the quality of the reference, not the likelihood of a sale."
                          >
                            {s.confidence} confidence
                          </Chip>
                          {/* Polarity is not decoration: the API states that a negative
                              signal overrides the positive ones for outreach.

                              Gated on `active`, because a signal that a later
                              run observed to be FALSE must not keep counting
                              against the company. Three "website unreachable"
                              signals stood against Ultra Taps, chipped in red,
                              after the site had recovered and been read
                              successfully. Expired evidence is history, not a
                              mark against anybody. */}
                          {s.polarity === 'negative' && s.status === 'active' && (
                            <Chip tone="danger" title="A negative signal overrides positive ones for outreach purposes.">
                              counts against outreach
                            </Chip>
                          )}
                          {s.status !== 'active' && (
                            <Chip
                              title={
                                supersededNote(s) ??
                                'Status follows the reference: a stale reference expires, and a low-quality or undated one is weak.'
                              }
                            >
                              {s.status}
                            </Chip>
                          )}
                          {/* What overtook it, on the card rather than only in
                              the drawer: "expired" alone does not tell a reader
                              that the thing is no longer true. */}
                          {supersededNote(s) && <span className="sig__superseded">{supersededNote(s)}</span>}
                          {/* Signals persist per run. One recorded by a previous
                              run says so, rather than passing as this run's. */}
                          {latestRunId && s.intentRunId && s.intentRunId !== latestRunId && (
                            <Chip title={`Recorded by run ${s.intentRunId}, not the latest run ${latestRunId}.`}>
                              earlier run
                            </Chip>
                          )}
                        </div>

                        {/* What happened, then why it matters. The second line
                            used to live only inside the drawer, which meant the
                            list answered "what did you find" and left "so
                            what" to whoever opened every card in turn. */}
                        <p className="sig__summary">{s.summary}</p>
                        {(s.interpretation ?? '').trim() && (
                          <p className="sig__why">
                            <span className="sig__whylabel">Why it matters</span>
                            {s.interpretation}
                          </p>
                        )}

                        <div className="sig__foot">
                          {platformOf(s) && <span className="sig__platform">{platformOf(s)}</span>}
                          <span className="sig__where">
                            {s.sourceUrl ? (
                              <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">
                                {sourceLabel(s)}
                              </a>
                            ) : (
                              sourceLabel(s)
                            )}
                          </span>
                          <span className="sig__when">{whenLabel(s)}</span>
                          <EvidenceButton
                            title={readableType(s.signalType)}
                            label="View Reference"
                            items={evidenceFor(s)}
                          />
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </Panel>
            </>
          }
          side={
            <>
              <Panel
                title="Latest run"
                subtitle={following ? 'Following this run — re-read every 4 s while the tab is open.' : undefined}
              >
                {!run ? (
                  <Unset what={word === 'STATUS UNKNOWN' ? 'Could not be read' : 'No run for this company'} />
                ) : (
                  <div className="stack sig-run">
                    <Field label="Run" value={run.id} mono />
                    <Field label="Queued" value={clock(run.createdAt)} />
                    <Field label="Started" value={run.startedAt ? clock(run.startedAt) : <Unset what={word === 'QUEUED' ? 'Not yet picked up' : 'Not recorded'} />} />
                    <Field label="Finished" value={run.completedAt ? clock(run.completedAt) : <Unset what={active ? 'Not yet' : 'Not recorded'} />} />
                    {(word === 'COMPLETED' || word === 'PARTIAL' || word === 'BLOCKED') && (
                      <Field
                        label="This run"
                        value={`${run.signalCount} signal${run.signalCount === 1 ? '' : 's'} observed · ${run.duplicatesCollapsed} duplicate${run.duplicatesCollapsed === 1 ? '' : 's'} collapsed`}
                      />
                    )}
                    {word === 'FAILED' && (
                      <Field label="Failure" value={run.failureReason ? <q className="sig-run__quote">{run.failureReason}</q> : <Unset what="No reason recorded" />} />
                    )}

                    {/* The run's own account of which sources ran. Read from
                        the detail; when only the list row is known it says so
                        rather than listing every provider as having run. */}
                    <div className="sig-run__providers">
                      <span className="eyebrow">Providers</span>
                      {providers.length ? (
                        <ul className="sig-run__list">
                          {providers.map((p) => {
                            const kind = outcomeKind(p)
                            return (
                              <li key={p.provider} className={`sig-run__provider sig-run__provider--${kind === 'failed' ? 'down' : kind}`}>
                                <span className="sig-run__pname">{readableType(p.provider)}</span>{' '}
                                <span className={kind === 'ran' && p.signals > 0 ? 'sig-run__pcount tnum' : 'sig-run__preason'}>
                                  {outcomeText(p)}
                                </span>
                              </li>
                            )
                          })}
                        </ul>
                      ) : detail.error ? (
                        <p className="sig-run__note">Provider outcomes could not be read: {detail.error.message}</p>
                      ) : active ? (
                        <p className="sig-run__note">Recorded when the run finishes.</p>
                      ) : detail.loading ? (
                        <p className="sig-run__note">Reading…</p>
                      ) : (
                        <Unset what="Not recorded on this run" />
                      )}
                    </div>
                  </div>
                )}
              </Panel>

              {/* WHAT EACH SOURCE ACTUALLY ANSWERED.
                  "Signals detected: 0" is the wrong headline when a platform
                  refused to serve the page. A login wall and an empty account
                  are opposite findings, and the provider records which is
                  which — so it is shown, per platform, rather than collapsed
                  into a count. */}
              {sourceAccess.length > 0 && (
                <Panel title="Sources reached" subtitle="What each platform served a logged-out reader">
                  <div className="stack">
                    {sourceAccess.map((a) => (
                      <div key={a.url} className="sig-src">
                        <span className="sig-src__platform">{a.platform}</span>
                        <Chip tone={ACCESS_TONE[a.access] ?? 'neutral'}>{a.access.replace(/_/g, ' ')}</Chip>
                        <a className="sig-src__link" href={a.url} target="_blank" rel="noopener noreferrer">
                          View Reference
                        </a>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              <Panel title="By source">
                {Object.keys(byCategory).length === 0 ? (
                  <Unset what={countIsFinding ? 'Nothing detected' : 'Nothing recorded'} />
                ) : (
                  <div className="stack">
                    {Object.entries(byCategory).map(([cat, n]) => (
                      <div key={cat} className="bar">
                        <span className="bar__label">{cat}</span>
                        <span className="bar__track">
                          <span
                            className="bar__fill"
                            style={{ width: `${(n / rows.length) * 100}%`, background: engine.accent }}
                          />
                        </span>
                        <span className="bar__value tnum">{n}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              {disclaimers.length > 0 && (
                <Panel title="What this does not say">
                  <ul className="sig-notes">
                    {disclaimers.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </Panel>
              )}
            </>
          }
        />
      )}
    </EnginePage>
  )
}

/**
 * The one sentence under the waveform: what state the run is in, for this
 * company, in words. It is the answer to "did this run?", which the count
 * beneath it could never give on its own.
 */
function RunSentence({
  word,
  run,
  name,
  providers,
  queuedForMs,
  workerSuspect,
}: {
  word: RunWord
  run: IntentRunDetail | null
  name: string
  providers: ProviderOutcome[]
  queuedForMs: number
  workerSuspect: boolean
}) {
  const down = providers.filter((p) => outcomeKind(p) === 'failed')

  switch (word) {
    case 'NOT RUN':
      return <p className="sig-run__sentence">Signal detection has not run for {name}. Nothing has been looked for, so nothing is recorded.</p>
    case 'QUEUED':
      return (
        <div className="sig-run__sentence">
          <p>
            Detection is queued for {name} — waiting {duration(queuedForMs)} for the queue worker to pick it up.
          </p>
          {workerSuspect && (
            <p className="sig-run__wait" role="status">
              <Clock size={14} aria-hidden="true" />
              Nothing has picked this run up. Jobs are worked by a separate process (<code>npm run dev:worker</code>), and
              a live worker starts a queued run within seconds — it is most likely not running. This screen will move on
              its own once the run is picked up; nothing below is a count of zero.
            </p>
          )}
        </div>
      )
    case 'RUNNING':
      return (
        <p className="sig-run__sentence">
          Detection is running for {name}
          {run?.startedAt ? ` since ${clock(run.startedAt)}` : ''}. Signals appear when the run completes.
        </p>
      )
    case 'COMPLETED':
      return (
        <p className="sig-run__sentence">
          {run && run.signalCount > 0
            ? `Signal detection completed${run.completedAt ? ` ${clock(run.completedAt)}` : ''} — ${run.signalCount} signal${run.signalCount === 1 ? '' : 's'} observed in the latest run.`
            : `Signal detection completed${run?.completedAt ? ` ${clock(run.completedAt)}` : ''} — no qualifying signals observed.`}
        </p>
      )
    case 'PARTIAL':
      return (
        <p className="sig-run__sentence">
          {`Signal detection completed, but ${down.length} of ${providers.length} providers failed (${down
            .map((p) => readableType(p.provider))
            .join(', ')}). What is recorded is a partial reading of ${name}, not a complete one.`}
        </p>
      )
    case 'BLOCKED':
      return (
        <p className="sig-run__sentence">
          Signal detection completed without looking anywhere: none of the {providers.length} providers could run for{' '}
          {name}. Nothing below is a finding about the company.
        </p>
      )
    case 'FAILED':
      return (
        <div className="sig-run__sentence">
          <p>Signal detection failed for {name}.</p>
          <p className="sig-run__fail">
            <span className="eyebrow">The run recorded</span>{' '}
            {run?.failureReason ? <q className="sig-run__quote">{run.failureReason}</q> : <Unset what="no reason" />}
          </p>
        </div>
      )
    case 'STATUS UNKNOWN':
      return (
        <p className="sig-run__sentence">
          Whether detection has run for {name} cannot be established
          {run?.status ? ` — the latest run carries the status "${run.status}", which this screen does not know` : ''}.
        </p>
      )
  }
}

/**
 * The list when there is nothing in it — which means a different thing for
 * each state of the run, and the title says which.
 */
function NoRows({
  word,
  run,
  name,
  providers,
  action,
}: {
  word: RunWord
  run: IntentRunDetail | null
  name: string
  providers: ProviderOutcome[]
  action?: React.ReactNode
}) {
  const down = providers.filter((p) => outcomeKind(p) === 'failed')
  const notRun = providers.filter((p) => !p.ok)

  switch (word) {
    case 'NOT RUN':
      return (
        <EmptyState
          icon={Radar}
          title={`Signal detection has not run for ${name}.`}
          detail="No intent detection run exists for this company. Intent detection reads the CRM, the company website’s technology, the public profiles the company links to, and the open web, and records only what those sources actually stated — job postings are not used as intent signals — until it runs, there is nothing to show and nothing to count."
          action={action}
        />
      )
    case 'QUEUED':
      return (
        <EmptyState
          icon={Clock}
          title="Nothing has been looked for yet"
          detail="The run is queued and has not been picked up. Signals appear here once the worker has processed it; this is not a count of zero."
        />
      )
    case 'RUNNING':
      return (
        <EmptyState
          icon={Radar}
          title="Detection is running"
          // Signals are stored once, at the end of the run — the list never
          // filled in "as they finish" (2026-10-06).
          detail="The sources are being read now. Signals are recorded together when the run completes."
        />
      )
    case 'COMPLETED':
      return (
        <EmptyState
          title="Signal detection completed — no qualifying signals observed."
          detail={`Every provider that could run looked and reported nothing for ${name}. An absent signal means NOT DETECTED, never that the underlying thing is not happening.`}
        />
      )
    case 'PARTIAL':
      return (
        <EmptyState
          title="No signals from the providers that ran"
          detail={`${down.length} of ${providers.length} providers failed (${down.map((p) => `${readableType(p.provider)}: ${p.reason ?? 'no reason recorded'}`).join('; ')}), so this is not a complete reading of ${name}.`}
        />
      )
    case 'BLOCKED':
      return (
        <BlockedState
          what="Nothing was looked for"
          why={`None of the ${providers.length} providers could run: ${notRun.map((p) => `${readableType(p.provider)} — ${outcomeText(p)}`).join('; ')}.`}
          affects={`No signal for ${name} is a fact about our configuration, not about the company.`}
          remediation="Configure or restore the providers named above, then detect again."
        />
      )
    case 'FAILED':
      return (
        <EmptyState
          title="The latest run failed before recording anything"
          detail={run?.failureReason ? <q className="sig-run__quote">{run.failureReason}</q> : 'The run recorded no reason.'}
          action={action}
        />
      )
    case 'STATUS UNKNOWN':
      return (
        <EmptyState
          title={`Nothing can be said about signals for ${name}`}
          detail='The run status could not be read, so "not run" and "nothing found" cannot be told apart. No count is shown for that reason.'
        />
      )
  }
}
