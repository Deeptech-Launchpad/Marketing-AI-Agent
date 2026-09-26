import { useEffect, useRef, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { api, Resource } from '../lib/api'
import { useAsync, useEngineAction, usePolling, useResource } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import { RefreshCw } from 'lucide-react'
import { useEngine, EnginePage, EngineSplit, type EngineCompletion } from '../components/shell/EnginePage'
import type { AgentState } from '../components/agent/AgentMark'
import { Panel, Metric, MetricRow, Chip, Button, StatusBadge, Unset, Field } from '../components/ui/primitives'
import { AsyncBoundary, EmptyState, ErrorState, LineageMismatch, LoadingState } from '../components/ui/states'
import { LayerReveal } from '../components/motion/Signatures'
import { EvidenceButton, type EvidenceItem } from '../components/ui/Evidence'
import { DataTable } from '../components/ui/DataTable'
import type { EnrichmentList, EnrichmentRow, UiStatus } from '../lib/types'
import { latestPerCompany, technologySummary } from '../lib/enrichmentSummary'
import './enrichment.css'

// Company Enrichment (#977).
//
// Technologies are only ever shown with the reference that detected them —
// a header, a script tag, a fragment of markup. A detection with no evidence
// would be a guess, and this engine does not make guesses.
//
// The centre now answers "what do we know about THIS company", which is not
// the question the screen used to answer. It opened on a technology grid with
// the workspace-wide register beside it, so a manager could see that
// enrichment had run without being able to say what it had learned — and the
// register, which is about every other company, was the tallest thing on the
// page. The register is still here, closed, at the bottom.
//
// The evidence rule now covers every line, not only the detections: each CRM
// fact and each website signal carries the observation it came from, in the
// summary-first shape, so checking a claim starts with a sentence rather than
// with raw markup.
//
// The screen also switches on the run's STATE before it draws a number. A row
// the worker had not picked up yet used to sit beside "0 technology signals /
// 0 facts recorded", which reads as a site that was read and found empty. A
// queued run has read nothing, so it has no counts — the state is shown in
// their place, and the counts arrive only when the run finishes.

/** The stage's own word for "could not be verified". Never an absent value. */
const UNKNOWN = 'UNKNOWN'

interface TechEvidence {
  what?: string
  where?: string
  fragment?: string
  sourceUrl?: string
}

/**
 * The `signals` object the enrichment row carries.
 *
 * Mirrors CompanySignals in src/enrichment/companyEnrichment.ts. Every string
 * field can also arrive as the literal UNKNOWN, so nothing here is read as
 * text without going through observedText first.
 */
interface EnrichmentSignals {
  industry?: string
  country?: string
  domain?: string
  crmCms?: string
  websiteStatus?: string
  finalUrl?: string
  pageTitle?: string
  metaDescription?: string
  generator?: string
  hasStructuredData?: boolean | string
  hasProductSchema?: boolean | string
}

/** One labelled claim, as src/domain/provenance.ts records it on the run. */
interface ProvenanceClaim {
  label: string
  statement: string
}

interface EnrichmentDetail extends Omit<EnrichmentRow, 'technologies'> {
  technologies?: Array<{
    name: string
    category: string
    /** Absent on detections recorded without a confidence grade. */
    confidence?: string
    /**
     * Either a structured chain, or the single markup fragment the detector
     * matched on — whichever form the detector produced is what is stored.
     */
    evidence?: string | TechEvidence[] | null
  }>
  signals?: EnrichmentSignals | null
  provenance?: ProvenanceClaim[] | null
  fetchedAt?: string | null
  /**
   * The serialised exception, on a row the worker's catch block wrote. That
   * path records no failureReason — the message is in here or nowhere.
   */
  error?: { message?: string } | null
  /** The stage's stated limits, sent back with every record. */
  disclaimers?: string[]
}

/** A provenance label, said the way a reader would say it. */
const CLAIM_LABEL: Record<string, string> = {
  crm_data: 'From the CRM',
  research: 'Observed on the site',
  knowledge: 'Known',
  user_intent: 'Asked for',
  ai_inference: 'Inferred',
}

/**
 * What a detection's category is, defined rather than interpreted.
 *
 * These say what KIND of software was matched. They deliberately say nothing
 * about how this particular company uses it, because a fingerprint in
 * delivered markup cannot support that and a manager would read it as if it
 * could.
 */
const CATEGORY_MEANING: Record<string, string> = {
  ecommerce: 'An e-commerce platform: the software that generates the shop and its product pages.',
  cms: "A content management system: the software the site's pages are authored in and served from.",
  pim: 'A product information manager: the system a business keeps structured product attributes in.',
  erp: 'A business system whose presence is visible from the public site.',
  framework:
    'A front-end framework or build tool. It shapes how pages are rendered, not where the product data comes from.',
  declared:
    'A self-declaration. It names the software accurately, but says nothing about what kind of product it is — this one could be a shop, a CMS or a plugin.',
}

// ── The run's state, in the pipeline's words ─────────────────────────────

/** The seven words every engine on the pipeline uses for where a run got to. */
type EngineStatus = 'not_run' | 'queued' | 'running' | 'completed' | 'partial' | 'blocked' | 'failed'

/**
 * The row's own word, mapped onto the pipeline vocabulary.
 *
 * 'enriched' is this engine's COMPLETED. 'unreachable' is PARTIAL: the CRM
 * half of the record was written and the site half was not. 'no_website' is
 * BLOCKED: nothing can be read until the NXT Sales record carries an address.
 * The mapping is explicit rather than pattern-matched because the shared
 * toUiStatus files 'queued' under "running", which spun a progress icon
 * beside a row nothing was working on.
 */
function statusOf(raw: string | null | undefined): EngineStatus {
  switch (raw) {
    case 'queued':
      return 'queued'
    case 'running':
      return 'running'
    case 'enriched':
      return 'completed'
    case 'unreachable':
    case 'partial':
      return 'partial'
    case 'no_website':
      return 'blocked'
    case 'failed':
      return 'failed'
    default:
      // A word this screen does not know is neither a failure nor a success.
      // It is drawn as partial; the row's own word stays visible beside it.
      return raw ? 'partial' : 'not_run'
  }
}

/** The badge for each state: the word, and the tone it is drawn in. */
const STATUS_BADGE: Record<EngineStatus, { word: string; tone: UiStatus }> = {
  not_run: { word: 'Not run', tone: 'idle' },
  queued: { word: 'Queued', tone: 'review' },
  running: { word: 'Running', tone: 'running' },
  completed: { word: 'Enriched', tone: 'complete' },
  partial: { word: 'Partial', tone: 'blocked' },
  blocked: { word: 'Blocked', tone: 'blocked' },
  failed: { word: 'Failed', tone: 'error' },
}

/**
 * How long a run may sit at 'queued' before the screen says the worker is
 * probably not running.
 *
 * Jobs are consumed by a separate process (src/worker.ts). When it is down,
 * every "Run enrichment" click still answers 202 and writes a queued row, and
 * that row never moves. Thirty seconds is far longer than a live worker takes
 * to pick a job up, and short enough that the person who clicked is still
 * looking at the screen.
 */
const WORKER_WAIT_MS = 30_000

/** How often an active run is re-read. Named so the copy and the timer agree. */
const POLL_MS = 4000

/**
 * Why a run stopped short, from whichever field the worker wrote it to.
 *
 * `finish()` records a failureReason for unreachable and no_website; the
 * catch block that writes 'failed' records the serialised exception instead.
 */
function failureOf(detail: EnrichmentDetail): string | null {
  const reason = detail.failureReason?.trim() || detail.error?.message?.trim()
  return reason || null
}

/**
 * Why a run found no website, in the run's own words.
 *
 * Newer rows store the resolver's reason as failureReason. Older rows carry it
 * only as a CRM provenance claim, after the "Company loaded" and "Industry"
 * lines — so it is looked for there before any generic wording is used.
 */
export function noWebsiteReason(detail: Pick<EnrichmentDetail, 'failureReason' | 'provenance'>): string | null {
  const stored = detail.failureReason?.trim()
  if (stored) return stored
  const claim = (detail.provenance ?? []).find(
    (c) => c.label === 'crm_data' && !/^Company ".*" loaded from/.test(c.statement) && !/^Industry:/.test(c.statement),
  )
  return claim?.statement?.trim() || null
}

/**
 * Normalises a detection's evidence into the chain this page renders.
 *
 * A raw fragment is evidence just as much as a structured entry is, so it is
 * carried through as one rather than dropped for arriving in another shape.
 */
function evidenceChain(evidence: string | TechEvidence[] | null | undefined): TechEvidence[] {
  if (!evidence) return []
  if (Array.isArray(evidence)) return evidence
  const fragment = String(evidence).trim()
  return fragment ? [{ fragment }] : []
}

/**
 * The recorded value, or null where the stage wrote UNKNOWN.
 *
 * The response's own disclaimers insist UNKNOWN is not an absent value, and
 * putting the word itself on screen reads as data — so the caller is made to
 * say what an unverified field looks like instead.
 */
function observedText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text !== UNKNOWN ? text : null
}

/** true, false and UNKNOWN are three different answers here, and stay three. */
function observedFlag(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

/** The host of a URL, for reading. Falls back to trimming rather than to null. */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).host
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null
  }
}

/** One thing enrichment recorded, alongside the way to check it. */
interface Observation {
  key: string
  label: string
  /** Null when nothing was verified; `absent` is shown in its place. */
  value: string | null
  absent: string
  /** Observed prose — a title, a description — which wraps rather than fits. */
  long?: boolean
  evidence: EvidenceItem[]
}

/**
 * The CRM half of the record: what NXT Sales already held.
 *
 * Copied across unchanged and never checked against the page. Stage 2 reads
 * the CRM and does not write back to it, so where the two disagree the run
 * records the disagreement and leaves both values standing.
 */
function crmFacts(signals: EnrichmentSignals, at: string | null): Observation[] {
  // Only the CMS value is ever compared against the page, so only it carries
  // the line about a disagreement. Saying that of the industry or the country
  // would describe a check this stage does not perform.
  const unverified =
    'This is what somebody recorded in the CRM, not something this stage checked against the site. It is shown as the CRM’s answer, not as an observation.'

  const fields: Array<[string, string, string | undefined, string]> = [
    ['industry', 'Industry', signals.industry, unverified],
    ['country', 'Country', signals.country, unverified],
    ['domain', 'Domain on record', signals.domain, unverified],
    [
      'crmCms',
      'Platform on record',
      signals.crmCms,
      'This is the only CRM value the run compares against the page. Where the two disagree the comparison says so and both are left standing — Stage 2 does not correct the CRM.',
    ],
  ]

  return fields.map(([key, label, raw, why]) => {
    const value = observedText(raw)
    return {
      key,
      label,
      value,
      absent: 'Not held in NXT Sales',
      evidence: value
        ? [
            {
              title: `${label}: ${value}`,
              summary: `The NXT Sales company record holds "${value}". Enrichment copied it across unchanged.`,
              whyItMatters: why,
              what: `${label} = ${value}`,
              source: 'NXT Sales company record',
              at,
              field: key,
              how: 'Read from the CRM company record at the start of the run. Stage 2 reads NXT Sales; it never writes to it.',
            },
          ]
        : [],
    }
  })
}

/**
 * The web half: what the fetched page itself showed.
 *
 * Each entry carries the extraction that produced it, because "the page has no
 * meta description" and "this platform did not find one" are different claims
 * and only the second is provable from one fetch.
 */
function siteSignals(signals: EnrichmentSignals, sourceUrl: string | null, at: string | null): Observation[] {
  const pageUrl = observedText(signals.finalUrl) ?? sourceUrl
  const host = hostOf(pageUrl)
  const on = host ? ` on ${host}` : ''

  /** Every website signal was read from the same fetch, so they share a source. */
  const from = { source: host, sourceUrl: pageUrl, at }

  const title = observedText(signals.pageTitle)
  const description = observedText(signals.metaDescription)
  const generator = observedText(signals.generator)
  const structured = observedFlag(signals.hasStructuredData)
  const productSchema = observedFlag(signals.hasProductSchema)

  return [
    {
      key: 'finalUrl',
      label: 'Page read',
      value: pageUrl,
      absent: 'No page was read',
      evidence: pageUrl
        ? [
            {
              ...from,
              title: 'The page the signals below came from',
              summary: `The fetch finished on ${pageUrl}. Every website signal on this screen was read from that one page.`,
              whyItMatters:
                'One page is not the site. The Website Audit stage crawls the catalogue later; this stage looks at a single address.',
              what: pageUrl,
              field: 'finalUrl',
              how: 'The URL the guarded fetcher ended on, after every redirect it followed was re-validated.',
            },
          ]
        : [],
    },
    {
      key: 'pageTitle',
      label: 'Page title',
      value: title,
      absent: 'Could not be verified',
      long: true,
      evidence: title
        ? [
            {
              ...from,
              title: 'How the page titles itself',
              summary: `The page${on} carries the title "${title}".`,
              // No `what`: the observed value IS the fragment here, and the
              // drawer would print the same string twice under one fold.
              field: 'pageTitle',
              fragment: title,
              how: "Taken from the page's <title> element and decoded to plain text.",
            },
          ]
        : [],
    },
    {
      key: 'metaDescription',
      label: 'Meta description',
      value: description,
      absent: 'Could not be verified',
      long: true,
      evidence: description
        ? [
            {
              ...from,
              title: 'How the page describes itself',
              summary: `The page${on} describes itself as "${description}" in its description meta tag, which is the summary a site offers to search engines and link previews.`,
              field: 'metaDescription',
              fragment: description,
              how: 'Taken from the content attribute of <meta name="description">.',
            },
          ]
        : [],
    },
    {
      key: 'generator',
      label: 'Generator tag',
      value: generator,
      absent: 'Could not be verified',
      evidence: generator
        ? [
            {
              ...from,
              title: 'The software the site names itself',
              summary: `The page${on} declares "${generator}" in its generator meta tag. That is the site naming the software it runs, rather than a pattern this platform matched.`,
              whyItMatters:
                'A self-declaration catches platforms no fingerprint would ever match, and it is a stronger reference than an asset path. It also names only what wrote the tag, which can be a plugin rather than the platform.',
              field: 'generator',
              fragment: generator,
              how: 'Taken from the content attribute of <meta name="generator">.',
            },
          ]
        : [],
    },
    {
      key: 'hasStructuredData',
      label: 'Structured data',
      value: structured === null ? null : structured ? 'Present in the page' : 'Not found in the page',
      absent: 'Could not be verified',
      evidence:
        structured === null
          ? []
          : [
              {
                ...from,
                title: structured ? 'Structured data is published' : 'No structured data on this page',
                summary: structured
                  ? `The page${on} carries at least one application/ld+json block, so part of what it publishes is already machine-readable.`
                  : `No application/ld+json block was found in the page${on}. That is what this one fetch was served; it does not rule out structured data elsewhere on the site.`,
                what: `hasStructuredData = ${String(structured)}`,
                field: 'hasStructuredData',
                how: 'Detected by testing the delivered HTML for an application/ld+json script block.',
              },
            ],
    },
    {
      key: 'hasProductSchema',
      label: 'Product schema',
      value: productSchema === null ? null : productSchema ? 'Present in the page' : 'Not found in the page',
      absent: 'Could not be verified',
      evidence:
        productSchema === null
          ? []
          : [
              {
                ...from,
                title: productSchema ? 'Products are described in schema' : 'No product schema on this page',
                summary: productSchema
                  ? `The structured data on the page${on} includes a "@type": "Product" declaration, so products there are described in a form a machine can read.`
                  : `No "@type": "Product" declaration was found in the page${on}. This is one page, usually a homepage, so it says nothing yet about the product pages the Website Audit stage crawls.`,
                what: `hasProductSchema = ${String(productSchema)}`,
                field: 'hasProductSchema',
                how: 'Detected by testing the delivered HTML for a "@type": "Product" declaration.',
              },
            ],
    },
  ]
}

/**
 * The evidence behind one detection, in the summary-first shape.
 *
 * A fingerprint match and a generator tag are different kinds of evidence and
 * are never described as the same thing: one is a pattern this platform went
 * looking for, the other is the site naming its own software.
 */
function technologyEvidence(
  tech: { name: string; category: string; evidence: TechEvidence[] },
  host: string | null,
  pageUrl: string | null,
  at: string | null,
): EvidenceItem[] {
  const on = host ? ` served by ${host}` : ''
  const declared = tech.category === 'declared'

  const summary = declared
    ? `The page${on} names "${tech.name}" in its own generator meta tag. That is the site declaring the software it runs, not a pattern this platform matched against the markup.`
    : `Markup distinctive to ${tech.name} was found in the page${on}. The match proves the product left a trace in what the site delivered; it does not say how the business uses it.`

  const how = declared
    ? 'Read from <meta name="generator">, then recorded as declared rather than classified — the tag says what is running, not what kind of product it is.'
    : `Matched against the ${tech.category} fingerprint table, which keys on tokens distinctive to one vendor — an asset path, a CDN host or a namespaced identifier — rather than on the vendor's name appearing in prose.`

  const base = {
    title: tech.name,
    summary,
    whyItMatters: CATEGORY_MEANING[tech.category],
    field: tech.category,
    at,
    how,
  }

  // A detection with no stored fragment still gets an item: the drawer says
  // that nothing was kept behind it, which is the honest answer.
  if (!tech.evidence.length) {
    return [{ ...base, what: `${tech.name} (${tech.category})`, source: host, sourceUrl: pageUrl }]
  }

  return tech.evidence.map((e) => ({
    ...base,
    what: e.what ?? `${tech.name} (${tech.category})`,
    source: e.where ?? host,
    sourceUrl: e.sourceUrl ?? pageUrl,
    fragment: e.fragment,
  }))
}

/**
 * The five questions a manager asks, answered from this record alone.
 *
 * Every line is composed from what the run recorded. A run that could not read
 * a site says so here rather than being narrated as though it had.
 */
function readout(detail: EnrichmentDetail, factCount: number, companyName: string): Array<[string, ReactNode]> {
  const status = detail.status
  const site = detail.sourceUrl
  const techCount = detail.technologyCount
  const facts = `${factCount} recorded fact${factCount === 1 ? '' : 's'} about the company and its site`
  const factsLead = facts.charAt(0).toUpperCase() + facts.slice(1)

  // Only a finished run has a sourceUrl, so "no website on record" is a claim
  // that can only be made once the run has actually looked for one.
  const input: ReactNode = site ? (
    <>
      The one website on {companyName}&rsquo;s NXT Sales record —{' '}
      <a href={site} target="_blank" rel="noopener noreferrer">
        {hostOf(site)}
      </a>
      .
    </>
  ) : status === 'no_website' ? (
    `A company reference from NXT Sales, with no website this stage could read. ${
      noWebsiteReason(detail) ?? 'The run recorded no further reason.'
    }`
  ) : (
    'A company reference from NXT Sales. This run recorded no website against it.'
  )

  const did =
    status === 'enriched'
      ? 'Fetched that page once and read the markup it served back. No model was called at this stage, so nothing on this screen is an inference.'
      : status === 'partial'
        ? `Read that address, but what it served cannot be attributed to ${companyName}${detail.failureReason ? `: ${detail.failureReason}` : '.'}`
        : status === 'unreachable'
        ? `Tried to fetch that page and could not read it${detail.failureReason ? `: ${detail.failureReason}.` : '.'}`
        : status === 'no_website'
          ? 'Stopped before fetching anything: there was no address on the record to read.'
          : status === 'failed'
            ? `The run did not complete${detail.failureReason ? `: ${detail.failureReason}.` : '.'}`
            : status === 'running'
              ? 'Reading the page now.'
              : 'Queued. Nothing has been read from the site yet.'

  const found =
    status === 'queued' || status === 'running'
      ? 'Nothing yet — the run has not finished.'
      : status === 'enriched'
        ? techCount > 0
          ? `${techCount} technology signal${techCount === 1 ? '' : 's'}, and ${facts}.`
          : `No technology fingerprint matched — which means NOT DETECTED, never "no technology in use". ${factsLead}.`
        : status === 'partial'
          ? `No technology attributed to ${companyName} — the page read belongs to another site. ${factsLead}.`
          : factCount > 0
          ? `Nothing from the site. ${factsLead}, every one of them from the CRM.`
          : 'Nothing. Neither the CRM record nor the site yielded a value this run could stand behind.'

  const next =
    status === 'enriched'
      ? 'Intent Signals reads the same company next; the Website Audit later crawls the site this page came from.'
      : status === 'queued' || status === 'running'
        ? 'Wait for the run to finish. What it read appears here, with the reference for each line.'
        : 'Put a working website on the NXT Sales record and run enrichment again — every later stage that reads the site depends on this one address.'

  return [
    ['Input', input],
    ['Did', did],
    ['Found', found],
    ['Output', 'This record. Every line on it opens on the observation behind it — the markup, the tag or the CRM field it came from.'],
    ['Next', next],
  ]
}

/**
 * The website outcome as a headline word.
 *
 * A run that has not reached the site yet says so. Collapsing that into "none
 * on record" would put a fact on screen that the run has not established.
 */
function websiteOutcome(signals: EnrichmentSignals): ReactNode {
  switch (observedText(signals.websiteStatus)) {
    case 'reachable':
      return 'Read'
    case 'unreachable':
      return 'Could not be read'
    case 'no_website':
      return 'None on record'
    default:
      return <Unset what="Not read yet" />
  }
}

/** Label, value, and the way to check it — in the order they are read. */
function ObservationRow({ observation }: { observation: Observation }) {
  return (
    <div className="enrich__obs">
      <span className="enrich__obslabel">{observation.label}</span>
      <span className={`enrich__obsvalue${observation.long ? ' enrich__obsvalue--long' : ''}`}>
        {observation.value ?? <Unset what={observation.absent} />}
      </span>
      <EvidenceButton items={observation.evidence} title={observation.label} label="Reference" />
    </div>
  )
}

/**
 * The centre of the screen while there is nothing to count.
 *
 * Stands in for the counters while a run is QUEUED, RUNNING or FAILED. None
 * of those has read a site, so none has a technology count or a fact count —
 * and a "0" in either place is a claim about the site, not about the run.
 * Every sentence here is about the run.
 */
function RunState({
  status,
  detail,
  companyName,
  waitingForWorker,
  queuedForMs,
  following,
  onCheck,
  checking,
}: {
  status: EngineStatus
  detail: EnrichmentDetail
  companyName: string
  waitingForWorker: boolean
  queuedForMs: number
  following: boolean
  onCheck: () => void
  checking: boolean
}) {
  const reason = failureOf(detail)
  const seconds = Math.max(0, Math.round(queuedForMs / 1000))
  const queuedAt = detail.createdAt ? new Date(detail.createdAt) : null
  const finishedAt = detail.finishedAt ? new Date(detail.finishedAt) : null

  const title =
    status === 'running'
      ? 'Reading company website…'
      : status === 'failed'
        ? 'Enrichment failed'
        : waitingForWorker
          ? 'Queued and waiting for the worker'
          : 'Waiting to run'

  const body =
    status === 'running'
      ? `The worker has picked this run up and is fetching the one website on ${companyName}’s NXT Sales record. What it reads appears here, each line with the reference behind it.`
      : status === 'failed'
        ? reason
          ? 'The run did not complete. The worker recorded this reason:'
          : 'The run did not complete, and the worker recorded no reason. Run enrichment again; if it stops the same way, quote the run id below to engineering.'
        : waitingForWorker
          ? `This run was queued ${seconds} seconds ago and nothing has picked it up. Runs are worked by a separate process from the API (npm run dev:worker); while it is not running, every run stays queued and no website is read. Start the worker, then check again. Nothing here is zero — nothing has happened yet.`
          : `Enrichment for ${companyName} is queued for the worker, and nothing has been read from the site yet. This screen re-reads the run every ${POLL_MS / 1000} seconds until it moves.`

  const variant = status === 'failed' ? ' enrich__state--failed' : waitingForWorker ? ' enrich__state--waiting' : ''

  return (
    <div className={`enrich__state${variant}`} role="status" aria-live="polite">
      <p className="enrich__statetitle">{title}</p>
      <p className="enrich__statedetail">{body}</p>
      {status === 'failed' && reason && <blockquote className="enrich__statereason">{reason}</blockquote>}
      <p className="enrich__statemeta">
        {queuedAt && !Number.isNaN(queuedAt.getTime()) && (
          <span>
            Queued {queuedAt.toLocaleTimeString()}
            {status !== 'failed' ? ` · ${seconds}s ago` : ''}
          </span>
        )}
        {finishedAt && !Number.isNaN(finishedAt.getTime()) && <span>Stopped {finishedAt.toLocaleTimeString()}</span>}
        <span className="mono">Run {detail.id}</span>
        {following && <span>Following this run — re-reading every {POLL_MS / 1000} seconds.</span>}
      </p>
      {status !== 'failed' && (
        <div className="enrich__stateactions">
          <Button icon={RefreshCw} size="sm" onClick={onCheck} busy={checking}>
            Check again
          </Button>
        </div>
      )}
    </div>
  )
}

export function Enrichment() {
  const engine = useEngine('enrichment')
  const { company, reload: reloadCompanies } = useCompany()
  const { can } = useAuth()
  const id = company?.crmCompanyId

  const list = useAsync<EnrichmentList>((signal) => api.get('/enrichment', { signal }), [])

  // Three outcomes, kept apart: the record, the backend saying there is none
  // yet, or the request failing. The old nullOn404 read collapsed the last
  // two into null, and null was drawn as "Not enriched yet" — so a proxy
  // answering in the API's place, or a route that was not mounted, showed as
  // a company nobody had run enrichment on.
  const detail = useResource<EnrichmentDetail>(
    (signal) =>
      id
        ? api.resource<EnrichmentDetail>(`/enrichment/companies/${id}`, { signal })
        : Promise.resolve(Resource.absent<EnrichmentDetail>('No company is selected.', 'no_company')),
    [id],
    { enabled: Boolean(id) },
  )

  // Only the selected company's row is ever drawn. useAsync keeps the last
  // result in hand while the next loads, so for the moment after switching
  // company the previous company's record is still present — and a row that
  // names another company once the load has settled is a lineage fault, not
  // something to render under this company's name.
  const foreign = detail.data && detail.data.crmCompanyId !== id ? detail.data : null
  const record = foreign ? null : detail.data
  const loadingSelected = detail.loading || (foreign !== null && detail.refreshing)

  const status = statusOf(record?.status)
  const active = status === 'queued' || status === 'running'

  // A queued row is re-read until it moves. The worker is a separate process,
  // so 'queued' is also what a run looks like when nobody is consuming the
  // queue; the age of the row is what tells the two apart. Age is computed
  // per render, and every poll re-renders, so it advances without a second
  // timer.
  const following = usePolling(() => detail.refresh(), active, POLL_MS)
  const queuedForMs = record?.createdAt ? Math.max(0, Date.now() - new Date(record.createdAt).getTime()) : 0
  const waitingForWorker = status === 'queued' && queuedForMs > WORKER_WAIT_MS

  // The register counts this company's row too, so it is re-read once when
  // the run leaves the active states — not on every poll, which would fetch
  // two hundred rows every four seconds to keep a closed disclosure current.
  const wasActive = useRef(false)
  useEffect(() => {
    if (wasActive.current && !active) {
      list.refresh()
      // The shared context panel reads the same register; without this it kept
      // showing what was known before the run ("Website: Not recorded").
      reloadCompanies?.()
    }
    wasActive.current = active
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Normalised once, so everything below reads a single evidence shape.
  const technologies = (record?.technologies ?? []).map((t) => ({
    ...t,
    evidence: evidenceChain(t.evidence),
  }))
  const byCategory = technologies.reduce<Record<string, typeof technologies>>((acc, t) => {
    ;(acc[t.category] ??= []).push(t)
    return acc
  }, {})

  const signals = (record?.signals ?? {}) as EnrichmentSignals
  const observedAt = record?.fetchedAt ?? record?.finishedAt ?? null
  const pageUrl = observedText(signals.finalUrl) ?? record?.sourceUrl ?? null
  const pageHost = hostOf(pageUrl)

  const facts = crmFacts(signals, observedAt)
  const site = siteSignals(signals, record?.sourceUrl ?? null, observedAt)
  const factCount = [...facts, ...site].filter((o) => o.value !== null).length

  // The name the record itself carries, falling back to the selected one. The
  // enrichment row is the more specific of the two — it is the CRM name as of
  // the run — and neither is invented when both are missing.
  const shownName = record?.companyName ?? company?.companyName ?? 'This company'
  const claims = record?.provenance ?? []
  const reason = record ? failureOf(record) : null
  const techCount = record?.technologyCount ?? 0

  // The badge: the pipeline word, in the tone the state deserves. A queue the
  // worker has not touched in thirty seconds needs attention, not patience,
  // so it moves to the blocked tone while keeping the word "Queued".
  const badge = waitingForWorker ? { word: 'Queued', tone: 'blocked' as UiStatus } : STATUS_BADGE[status]
  const statusBadge = <StatusBadge status={badge.tone} label={badge.word} size="sm" />

  // What the footer says. Completion is claimed only for 'enriched'; the
  // three other terminal states name themselves, so a person is never sent
  // on to Intent Signals believing the site has been read when it has not.
  const completion: EngineCompletion | undefined =
    status === 'completed'
      ? {
          done: true,
          label: `Enrichment complete — ${techCount} technology signal${techCount === 1 ? '' : 's'}, ${factCount} fact${factCount === 1 ? '' : 's'} recorded`,
        }
      : status === 'partial'
        ? record?.status === 'partial'
          ? { done: false, blockedReason: `Partial — ${reason ?? 'what was read could not be attributed to this company.'}` }
          : {
              done: false,
              blockedReason: `Partial — the website could not be read${reason ? ` (${reason})` : ''}. Only what NXT Sales holds was recorded.`,
            }
        : status === 'blocked'
          ? {
              done: false,
              blockedReason: 'Blocked — the NXT Sales record has no website to read. Add one and run enrichment again.',
            }
          : status === 'failed'
            ? { done: false, blockedReason: `Failed${reason ? ` — ${reason}` : ''}` }
            : undefined

  // The header mark follows the run rather than the fetch: a queued row is
  // not "running", and a row the API could not read is not "idle".
  // The engine's real work, triggered by a person. The endpoint takes a
  // BATCH of company references, so the selected company is sent as a
  // one-element array — the shape the schema accepts.
  //
  // Declared BEFORE headState because headState reads run.running. A function
  // wrapper does not buy any freedom here: hoisting lifts the function, not the
  // const it closes over, so calling it earlier still lands in the temporal
  // dead zone and takes the whole screen down with "Cannot access 'run' before
  // initialization".
  const run = useEngineAction(async () => {
    if (!id) return
    await api.post('/enrichment/companies', { crmCompanyIds: [id] })
    detail.refresh()
    list.refresh()
    reloadCompanies?.()
  })

  const headState: AgentState =
    run.running || status === 'running'
      ? 'running'
      : status === 'completed'
        ? 'success'
        : status === 'failed' || detail.error
          ? 'error'
          : 'idle'

  // Disabled for as long as this company's latest run is queued or running,
  // not just while the POST is in flight: a second click used to queue a second
  // run for the same company. The server refuses duplicates too.
  const action = can('operate') && id && (
    <Button
      icon={RefreshCw}
      variant="primary"
      onClick={run.fire}
      busy={run.running}
      disabled={active || run.running}
      title={active ? 'Enrichment for this company is already in progress.' : undefined}
    >
      Run enrichment
    </Button>
  )

  // Distinct companies, not runs. The server now returns one row per company,
  // but an older server (or ?view=runs) returns every attempt, so the count is
  // made safe here as well.
  const registerCompanies = latestPerCompany(list.data?.enrichments ?? []).length

  // Available, not prominent: the register answers "what else has this platform
  // touched", which is a different question from the one this screen answers.
  const register = (
    <details className="panel enrich__more">
      <summary>
        <span className="enrich__moretitle">All enrichments across the workspace</span>
        <span className="enrich__morecount">
          {/* Counted defensively. `list.data` being present does not guarantee
              it carries the array — a proxy, a cached older shape or an error
              envelope served with a 200 all satisfy the truthiness check, and
              reading .length off the missing array threw here, which took the
              whole screen down and the Run enrichment button with it. The
              boundary below already guards the same way. */}
          {list.data ? `${registerCompanies} compan${registerCompanies === 1 ? 'y' : 'ies'}` : ''}
        </span>
      </summary>
      <AsyncBoundary
        state={list}
        what="Reading enrichment runs"
        isEmpty={(d) => (d.enrichments?.length ?? 0) === 0}
        empty={<EmptyState title="No enrichment yet" />}
      >
        {(d) => {
          const latest = latestPerCompany(d.enrichments)
          return (
          <>
            <div style={{ padding: 'var(--s4)' }}>
              <MetricRow>
                <Metric label="Companies" value={latest.length} size="sm" />
                {/* `enriched` is this engine's success word — the count read zero
                    on every workspace while it was matched on 'succeeded' and
                    'completed' alone, neither of which enrichment ever writes.
                    Counted over each company's LATEST run, so a company run
                    three times is one company. */}
                <Metric
                  label="Succeeded"
                  value={latest.filter((e) => e.status === 'enriched' || e.status === 'succeeded' || e.status === 'completed').length}
                  size="sm"
                />
              </MetricRow>
            </div>
            <DataTable
              rows={latest.slice(0, 40)}
              rowKey={(r) => r.id}
              selectedKey={latest.find((e) => e.crmCompanyId === id)?.id}
              columns={[
                { key: 'name', header: 'Company', render: (r) => r.companyName ?? r.crmCompanyId },
                { key: 'tech', header: 'Tech', render: (r) => technologySummary(r) },
              ]}
            />
          </>
          )
        }}
      </AsyncBoundary>
    </details>
  )

  return (
    <EnginePage
      engineId="enrichment"
      state={headState}
      signature={<LayerReveal accent={engine.accent} layers={3} />}
      actions={action}
      completion={completion}
    >
      <EngineSplit
        main={
          !company ? (
            <EmptyState
              title="No company selected"
              detail="Company Enrichment works on one company at a time, and nothing on this screen is shown without one. Pick a company in the sidebar, or find a new one in Prospect Discovery — a lead chosen there stays selected through every engine."
              action={
                <Link to="/prospect" className="btn btn--ghost btn--md">
                  Go to Prospect Discovery
                </Link>
              }
            />
          ) : loadingSelected ? (
            <LoadingState what="Reading what enrichment recorded for this company" visual={<LayerReveal accent={engine.accent} />} />
          ) : detail.error ? (
            // The request failed, so nothing about this company is known —
            // and in particular nothing about it is zero.
            <ErrorState
              error={detail.error}
              what="Reading what enrichment recorded for this company"
              affects={`${shownName}. Whether enrichment has run, and what it found, is unknown until this read succeeds.`}
              onRetry={detail.refresh}
            />
          ) : foreign ? (
            <LineageMismatch what="enrichment record" expected={id!} found={foreign.crmCompanyId} onReload={detail.refresh} />
          ) : !record ? (
            <EmptyState
              title="Not run yet"
              detail={`${shownName} has no enrichment record${detail.absent ? ` — the API says "${detail.absent}"` : ''}. Enrichment reads the one website the CRM holds and records only what it can point at — run it to find out what that site publishes about itself.`}
            />
          ) : active || status === 'failed' ? (
            <>
              {/* The counters are not drawn for these states: a run that has
                  read nothing has no counts, and "0" here was being read as
                  "the site was read and found empty". */}
              <Panel
                title={`What we know about ${shownName}`}
                subtitle={status === 'failed' ? 'The run did not complete' : 'Nothing has been read yet — the run has not finished'}
                actions={statusBadge}
              >
                <RunState
                  status={status}
                  detail={record}
                  companyName={shownName}
                  waitingForWorker={waitingForWorker}
                  queuedForMs={queuedForMs}
                  following={following}
                  onCheck={detail.refresh}
                  checking={detail.refreshing}
                />
              </Panel>
              {register}
            </>
          ) : (
            <>
              <Panel
                title={`What we know about ${shownName}`}
                subtitle="Read from the company's own website and its NXT Sales record"
                actions={statusBadge}
              >
                <MetricRow>
                  {/* A count only for a run that read the site. For PARTIAL
                      and BLOCKED the fingerprint table was never consulted,
                      and "0" would say it was. */}
                  <Metric
                    label="Technology signals"
                    value={
                      status === 'completed' ? (
                        record.technologyCount
                      ) : (
                        <Unset what={record.status === 'partial' ? 'Not attributed' : 'Site not read'} />
                      )
                    }
                    size="lg"
                    accent
                  />
                  <Metric label="Facts recorded" value={factCount} size="lg" />
                  <Metric label="Website" value={websiteOutcome(signals)} hint={pageHost ?? undefined} size="lg" />
                </MetricRow>

                <dl className="enrich__readout">
                  {readout(record, factCount, shownName).map(([label, body]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{body}</dd>
                    </div>
                  ))}
                </dl>
              </Panel>

              <Panel title="Company and website" subtitle="Every line opens on the observation behind it">
                <div className="enrich__group">
                  <div className="enrich__grouphead">
                    <span className="enrich__groupname">From NXT Sales</span>
                    <span className="enrich__groupnote">Copied unchanged. This stage never writes back to the CRM.</span>
                  </div>
                  {facts.map((o) => (
                    <ObservationRow key={o.key} observation={o} />
                  ))}
                </div>

                <div className="enrich__group">
                  <div className="enrich__grouphead">
                    <span className="enrich__groupname">Observed on the website</span>
                    <span className="enrich__groupnote">
                      {pageHost ? `Read from one page on ${pageHost}.` : 'No page was read on this run.'}
                    </span>
                  </div>
                  {site.map((o) => (
                    <ObservationRow key={o.key} observation={o} />
                  ))}
                </div>
              </Panel>

              <Panel
                title="Technology detected on the site"
                subtitle={
                  technologies.length
                    ? `${record.technologyCount} signal${record.technologyCount === 1 ? '' : 's'}, each carrying the markup that proved it`
                    : pageUrl
                      ? 'What the delivered markup showed'
                      : 'Nothing was fetched on this run'
                }
              >
                {technologies.length === 0 ? (
                  <EmptyState
                    title="Nothing detected"
                    detail={
                      // A run that never fetched anything is not the same as a
                      // page that matched nothing, and the old wording described
                      // a crawl to both of them.
                      reason ??
                      (pageUrl
                        ? 'The page was read and no fingerprint matched it. An undetected stack is reported as undetected rather than filled in — many platforms leave no trace in delivered markup.'
                        : 'No page was read on this run, so there was nothing to detect a platform in.')
                    }
                  />
                ) : (
                  <div className="layers">
                    {Object.entries(byCategory).map(([category, items], ci) => (
                      <section key={category} className="layers__row node-reveal" style={{ ['--i' as string]: ci }}>
                        <span className="layers__cat">{category}</span>
                        <div className="layers__items">
                          {items.map((t) => (
                            <div key={t.name} className="layers__tech" style={{ ['--e' as string]: engine.accent }}>
                              <div className="layers__techhead">
                                <span className="layers__techname">{t.name}</span>
                                {t.confidence ? (
                                  <Chip tone={t.confidence === 'high' ? 'ok' : t.confidence === 'medium' ? 'warn' : 'neutral'}>
                                    {t.confidence}
                                  </Chip>
                                ) : (
                                  <Unset what="Confidence not graded" />
                                )}
                              </div>
                              {CATEGORY_MEANING[t.category] && (
                                <p className="enrich__techmeaning">{CATEGORY_MEANING[t.category]}</p>
                              )}
                              {/* The evidence chain, as the reference lays it out. */}
                              {t.evidence.length ? (
                                <ul className="layers__ev">
                                  {t.evidence.slice(0, 3).map((e, i) => (
                                    <li key={i}>{e.what ?? e.fragment ?? e.where}</li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="layers__noev">No reference fragment stored.</p>
                              )}
                              <div className="enrich__techfoot">
                                <EvidenceButton
                                  items={technologyEvidence(t, pageHost, pageUrl, observedAt)}
                                  title={t.name}
                                  label="Why we say this"
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </Panel>

              {register}
            </>
          )
        }
        side={
          <>
            {record && (
              <Panel title="This run">
                {/* The pipeline word and the row's own word, side by side, so
                    an engineer reading 'unreachable' and a manager reading
                    "Partial" are looking at the same fact. */}
                <Field
                  label="Status"
                  value={
                    <span className="enrich__runstatus">
                      {statusBadge}
                      <span className="mono">{record.status}</span>
                    </span>
                  }
                />
                <Field
                  label="Technologies"
                  value={status === 'completed' ? technologySummary(record) : <Unset what={technologySummary(record)} />}
                />
                <Field
                  label="Source"
                  value={
                    record.sourceUrl ? (
                      <a href={record.sourceUrl} target="_blank" rel="noopener noreferrer">
                        {record.sourceUrl.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      <Unset what={active ? 'Not read yet' : 'Not recorded'} />
                    )
                  }
                />
                <Field label="Queued" value={record.createdAt ? new Date(record.createdAt).toLocaleString() : <Unset />} />
                <Field
                  label="Finished"
                  value={
                    record.finishedAt ? (
                      new Date(record.finishedAt).toLocaleString()
                    ) : (
                      // 'queued' has not started; only 'running' is still running.
                      <Unset what={status === 'queued' ? 'Not started' : status === 'running' ? 'Still running' : 'Not recorded'} />
                    )
                  }
                />
                <Field label="Run id" value={record.id} mono />
                <Field label="Company id" value={record.crmCompanyId} mono />
                {reason && (
                  <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>{reason}</p>
                )}
              </Panel>
            )}

            {claims.length > 0 && (
              <Panel title="How this record was produced" subtitle="The run's own account, claim by claim">
                <ul className="enrich__claims">
                  {claims.map((c, i) => (
                    <li key={i} className="enrich__claim">
                      <span className="enrich__claimlabel">{CLAIM_LABEL[c.label] ?? c.label}</span>
                      <span className="enrich__claimtext">{c.statement}</span>
                    </li>
                  ))}
                </ul>
                {record?.disclaimers?.length ? (
                  <div className="enrich__caveat">
                    {record.disclaimers.map((d, i) => (
                      <p key={i} className="note">
                        {d}
                      </p>
                    ))}
                  </div>
                ) : null}
              </Panel>
            )}
          </>
        }
      />
    </EnginePage>
  )
}
