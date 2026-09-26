import { useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../lib/api'
import { useAsync, usePolling, useResource, useEngineAction } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import { Users } from 'lucide-react'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, Button, Unset } from '../components/ui/primitives'
import { BlockedState, EmptyState, ErrorState, LoadingState } from '../components/ui/states'
import { RelationshipGraph } from '../components/motion/Signatures'
import { EvidenceButton } from '../components/ui/Evidence'
import type { DecisionMakerCandidate } from '../lib/types'

// Decision Makers (#978).
//
// This engine refuses to guess an email address, a phone number or a profile
// URL. Where a contact detail is absent the card says so — an inferred
// address would be worse than none, because somebody would try to use it.
//
// THE THREE OUTCOMES THIS SCREEN KEEPS APART
//
// GET /decision-makers/companies/:id/candidates answers 404 until a discovery
// run has COMPLETED for the company. The screen used to throw that away and
// render its zero state: an account map, four metrics reading 0, and "Nobody
// verified yet". So a company nobody had run discovery for, a company the
// engine had searched and verified nobody at, and an endpoint that was not
// answering at all all looked exactly the same — and only one of those is a
// finding about the company.
//
//   404 carrying the API's own error envelope -> discovery has not run yet,
//       said in the backend's own words, with the action that starts it
//   any other failure (a 404 with no envelope, a 5xx, an unreachable API)
//       -> the request failed, and NOTHING is known about this company's
//       people — least of all that there are none
//   200 -> the people, exactly as before

/**
 * How to describe a profile link without pretending to know what it is.
 *
 * The field holds whatever the source stated — a LinkedIn page, a ZoomInfo
 * entry, a page on the company's own site. Labelling all of them "LinkedIn"
 * would be a claim about provenance the value does not support, so the host
 * says it.
 */
function profileLabel(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '')
    return host.includes('linkedin.') ? 'LinkedIn profile' : `Profile on ${host}`
  } catch {
    return 'Public profile'
  }
}

/** Provider ids as an operator would say them. */
const PROVIDER_LABEL: Record<string, string> = {
  crm_contacts: 'NXT Sales CRM',
  linkedin_reference: 'LinkedIn reference',
  intent_social: 'Intent Signals (social)',
  apollo: 'Apollo',
  zoominfo: 'ZoomInfo',
  rocketreach: 'RocketReach',
  hunter: 'Hunter',
  company_website: 'Company website',
  public_web_research: 'Public web research',
}

export interface ProviderRow {
  provider: string
  status: string
  /** Whether a request actually reached the network. */
  queried: boolean
  /** A source that reads a record already held (CRM, stored signals). */
  local: boolean
  candidates: number
  reason: string | null
  metadata: Record<string, unknown> | null
}

function readProviders(raw: unknown): ProviderRow[] {
  if (!Array.isArray(raw)) return []
  return (raw as Array<Record<string, unknown>>)
    .filter((r) => typeof r?.provider === 'string')
    .map((r) => ({
      provider: String(r.provider),
      status: String(r.status ?? ''),
      // Absent on a run recorded before the field existed; such a run cannot
      // say, so it is not claimed either way.
      queried: r.queried === true,
      local: r.local === true,
      candidates: Number(r.candidates ?? 0),
      reason: typeof r.reason === 'string' ? r.reason : null,
      metadata: r.metadata && typeof r.metadata === 'object' ? (r.metadata as Record<string, unknown>) : null,
    }))
}

/**
 * What a provider's outcome actually was, in words that do not overclaim.
 *
 * Every status that was not a request used to read "not configured" — a
 * company with no domain, a plan without API access and a missing key all
 * looked alike — and an error or a rate limit read "queried — none found",
 * which is a claim about the company that nobody checked.
 */
export function providerStatusLabel(p: ProviderRow): { text: string; tone: 'ok' | 'neutral' | 'warn' | 'danger' } {
  if (p.candidates > 0) return { text: `${p.candidates} found`, tone: 'ok' }
  switch (p.status) {
    case 'error':
      return { text: 'error — result unknown', tone: 'danger' }
    case 'rate_limited':
      return { text: 'rate-limited — result unknown', tone: 'warn' }
    case 'unauthorized': {
      const planBlocked =
        p.metadata?.credentialValid === true || /plan does not include/i.test(p.reason ?? '')
      return planBlocked ? { text: 'plan lacks access', tone: 'warn' } : { text: 'no credential', tone: 'warn' }
    }
    case 'unavailable':
    case 'skipped':
      return { text: 'not eligible — not asked', tone: 'neutral' }
    case 'no_results':
    case 'available':
      if (p.local) return { text: 'checked — none on record', tone: 'neutral' }
      return p.queried ? { text: 'queried — none found', tone: 'neutral' } : { text: 'none found', tone: 'neutral' }
    default:
      return { text: p.status ? p.status.replace(/_/g, ' ') : 'status not recorded', tone: 'neutral' }
  }
}

/** The newest discovery run for the company, whatever its status. */
interface LatestRun {
  id: string
  status: string
  failureReason: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

function readLatestRun(raw: unknown): LatestRun | null {
  const run = (raw as { run?: unknown } | null)?.run as Record<string, unknown> | null | undefined
  if (!run || typeof run.id !== 'string' || typeof run.status !== 'string') return null
  return {
    id: run.id,
    status: run.status,
    failureReason: typeof run.failureReason === 'string' ? run.failureReason : null,
    createdAt: String(run.createdAt ?? ''),
    startedAt: typeof run.startedAt === 'string' ? run.startedAt : null,
    completedAt: typeof run.completedAt === 'string' ? run.completedAt : null,
  }
}

interface DiscoverResponse {
  runs?: Array<{ id: string; crmCompanyId: string; reused: boolean; failureReason?: string }>
}

type CandidateRow = DecisionMakerCandidate & { evidenceProviders?: string[] }

/** Which source(s) the evidence behind one person came from. */
function evidenceSourceLabel(c: CandidateRow): string {
  const fromRow = Array.isArray(c.evidenceProviders) ? c.evidenceProviders : []
  const fromEvidence = Array.isArray(c.evidence)
    ? (c.evidence as Array<{ provider?: unknown }>).map((e) => e?.provider).filter((x): x is string => typeof x === 'string')
    : []
  const providers = [...new Set(fromRow.length ? fromRow : fromEvidence)]
  if (!providers.length) return 'Source not recorded'
  return providers.map((p) => PROVIDER_LABEL[p] ?? p.replace(/_/g, ' ')).join(', ')
}

/**
 * A provider's own account of itself, without the wall of text.
 *
 * Some of these run to a paragraph - which plan a key lacks, which environment
 * variable is unset, why a scraper was deliberately not used - and every word
 * of it matters when that provider is the one you are debugging. It matters
 * not at all for the other six, which is why the panel became unreadable. So a
 * long note is clamped to its first lines and opens on request. Nothing is
 * summarised or dropped: the full text is one click away, every time.
 */
const LONG_NOTE = 180

function ProviderNote({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  if (text.length <= LONG_NOTE) return <p className="prov-row__why">{text}</p>

  return (
    <div className="prov-row__note">
      <p className={`prov-row__why${open ? '' : ' is-clamped'}`}>{text}</p>
      <button type="button" className="prov-row__more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'Show less' : 'Show more'}
      </button>
    </div>
  )
}

/**
 * Why each set-aside person was set aside, said once for the group.
 *
 * The run records a full sentence per person, and those sentences quote the
 * person's own title back - so four rows read as four paragraphs, three of
 * which say the same thing. The reason is a fact about a GROUP, so it is
 * stated once as a heading and the rows underneath stay to one line each.
 *
 * Grouped on the run's structured fields, never on the wording of its prose:
 * a reason sentence is written for a person to read, and matching on it would
 * break the moment it is reworded.
 */
interface AsideGroup {
  key: string
  heading: string
  detail: string
  people: CandidateRow[]
}

const ASIDE_BUCKETS = ['rejected', 'unverified', 'no_title', 'role', 'other'] as const
type AsideBucket = (typeof ASIDE_BUCKETS)[number]

const ASIDE_COPY: Record<AsideBucket, { heading: string; detail: string }> = {
  rejected: {
    heading: 'Works somewhere else',
    detail: 'A source places them at a different company, so they are not a decision maker here.',
  },
  unverified: {
    heading: 'Not tied to this company',
    detail:
      'A page named them, but no source states that they work here. Unproven employment is never presented as a decision maker.',
  },
  no_title: {
    heading: 'No job title stated',
    detail: 'No source stated what they do, so whether they own product data cannot be established.',
  },
  role: {
    heading: 'Role does not own product data',
    detail:
      'Their stated title is not one of the roles that own product or catalogue data — the people this platform approaches.',
  },
  other: {
    heading: 'Not shortlisted by this run',
    detail: 'Verified and relevant, but ranked behind the shortlist. Hover a name for the exact reason recorded.',
  },
}

function asideBucket(c: CandidateRow): AsideBucket {
  if (c.companyMatch === 'rejected') return 'rejected'
  if (c.companyMatch === 'unverified') return 'unverified'
  if (c.roleGroup === null && !c.rawTitle) return 'no_title'
  if (c.roleGroup === null) return 'role'
  return 'other'
}

export function asideGroups(rows: CandidateRow[]): AsideGroup[] {
  const groups = new Map<AsideBucket, CandidateRow[]>()
  for (const c of rows) {
    const key = asideBucket(c)
    const held = groups.get(key)
    if (held) held.push(c)
    else groups.set(key, [c])
  }
  return ASIDE_BUCKETS.filter((key) => groups.has(key)).map((key) => ({
    key,
    heading: ASIDE_COPY[key].heading,
    detail: ASIDE_COPY[key].detail,
    people: groups.get(key)!,
  }))
}

/** The page a set-aside person was read on, when a source recorded one. */
function evidenceUrl(c: CandidateRow): string | null {
  if (c.profileUrl) return c.profileUrl
  const first = Array.isArray(c.evidence)
    ? (c.evidence as Array<{ sourceUrl?: unknown }>).find((e) => typeof e?.sourceUrl === 'string')
    : null
  return (first?.sourceUrl as string) ?? null
}

const POLL_MS = 4000

export function DecisionMakers() {
  const engine = useEngine('decision-makers')
  const { company } = useCompany()
  const { can } = useAuth()
  const id = company?.crmCompanyId

  const candidates = useResource<{
    candidates: CandidateRow[]
    providerResults?: unknown
    peopleSeen?: number
    excludedCount?: number
  }>(
    // EVERYONE THE RUN SAW, not only the people it could verify.
    //
    // The shortlist answers "who do we approach". It does not answer "what did
    // the search actually turn up", and a screen that reports "2 set aside"
    // without naming them leaves a reader unable to check the engine's
    // judgement — or to see that the two people found were a spiritual
    // consultant and the founder of a different company. Both are shown, kept
    // firmly apart: verified people are the shortlist, and the rest are shown
    // with the reason they were set aside.
    (signal) => api.resource(`/decision-makers/companies/${id}/candidates?includeExcluded=true`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )

  // THE RUN ITSELF, not only its finished result. The candidates endpoint
  // reads completed runs only, so a search in progress or one that failed was
  // invisible: the button spun for the length of one HTTP call, the page
  // re-read once, and nothing said the worker was still going — or had died.
  const latest = useAsync<unknown>(
    (signal) => api.get(`/decision-makers/companies/${id}/runs/latest`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )
  const latestRun = latest.error ? null : readLatestRun(latest.data)
  const inFlight = latestRun?.status === 'queued' || latestRun?.status === 'running'
  const [trackedRunId, setTrackedRunId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const awaitingTracked = Boolean(trackedRunId) && !latest.error && latestRun?.id !== trackedRunId
  usePolling(latest.refresh, inFlight || awaitingTracked, POLL_MS)

  // A run that reaches completed re-reads the people; any terminal state stops
  // following it.
  const previous = useRef<{ id: string; status: string } | null>(null)
  useEffect(() => {
    if (!latestRun) return
    const before = previous.current
    previous.current = { id: latestRun.id, status: latestRun.status }
    const changed = !before || before.id !== latestRun.id || before.status !== latestRun.status
    const terminal = latestRun.status === 'completed' || latestRun.status === 'failed'
    if (changed && before && terminal && latestRun.status === 'completed') candidates.refresh()
    if (terminal && trackedRunId === latestRun.id) {
      setTrackedRunId(null)
      setNotice(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestRun?.id, latestRun?.status])

  const rows = candidates.data?.candidates ?? []
  // Which sources were actually asked. The panel below used to carry one
  // sentence of static prose, so a reader could not tell a provider that ran
  // and found nobody from one that was never configured — and, while the
  // chain still stopped early, could not tell either from one that was never
  // called at all.
  const providers = readProviders(candidates.data?.providerResults)
  const shortlisted = rows.filter((c) => c.outcome === 'shortlisted')
  // People who were found but not shortlisted, in the order the run ranked
  // them. They are not decision makers; they are what the search turned up.
  const aside = rows.filter((c) => c.outcome !== 'shortlisted')
  // Counted over the SHORTLIST, as they always were: these describe the people
  // this platform would approach, not everyone a page happened to mention.
  const withEmail = shortlisted.filter((c) => c.email).length
  const withPhone = shortlisted.filter((c) => c.phone).length
  const withheld = shortlisted.filter((c) => c.contactability === 'withheld_by_policy').length
  // The run's own counts. The list holds only the shortlist, so "people seen"
  // has to come from the run — otherwise it always equalled "shortlisted".
  const peopleSeen = typeof candidates.data?.peopleSeen === 'number' ? candidates.data.peopleSeen : rows.length
  const setAside =
    typeof candidates.data?.excludedCount === 'number'
      ? candidates.data.excludedCount
      : aside.length

  // The engine's real work, triggered by a person. The endpoint takes a
  // BATCH of company references, so the selected company is sent as a
  // one-element array — the shape the schema accepts.
  const run = useEngineAction(async () => {
    if (!id) return
    setNotice(null)
    const res = await api.post<DiscoverResponse>('/decision-makers/discover', { crmCompanyIds: [id] })
    const queued = res?.runs?.[0]
    if (queued?.failureReason) throw new Error(queued.failureReason)
    if (queued) {
      setTrackedRunId(queued.id)
      setNotice(
        queued.reused
          ? 'A search for this company is already running, so another was not started. This page is following that search.'
          : 'Search queued. This page follows it until it finishes.',
      )
    }
    latest.refresh()
  })

  const busy = run.running || inFlight
  const discover = can('operate') && id && (
    <Button icon={Users} variant="primary" onClick={run.fire} busy={busy}>
      {inFlight ? 'Search in progress' : 'Find decision makers'}
    </Button>
  )

  // What the latest search is doing, said above everything else.
  const runStatus = (
    <>
      {run.error && (
        <ErrorState error={run.error} what="The decision-maker search could not be started" onRetry={run.fire} />
      )}
      {inFlight && latestRun && (
        <p className="note" role="status">
          {latestRun.status === 'queued'
            ? 'A decision-maker search is queued and waiting for the worker.'
            : 'A decision-maker search is running.'}
          {notice ? ` ${notice}` : ''}
        </p>
      )}
      {!inFlight && notice && !run.error && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      {!inFlight && latestRun?.status === 'failed' && (
        <BlockedState
          what="The latest decision-maker search failed"
          why={latestRun.failureReason ?? 'No failure reason was recorded.'}
          affects="Any people shown come from the last search that completed, not from this one."
          remediation="Run the search again."
        />
      )}
    </>
  )

  return (
    <EnginePage
      engineId="decision-makers"
      state={
        busy
          ? 'running'
          : candidates.error || run.error || latestRun?.status === 'failed'
            ? 'error'
            : shortlisted.length
              ? 'success'
              : 'idle'
      }
      signature={<RelationshipGraph accent={engine.accent} count={rows.length} />}
      actions={discover}
      completion={{ done: false, nextTo: '/outreach' }}
    >
      {company && runStatus}
      {!company ? (
        <EmptyState title="Select a company" detail="Decision makers are discovered per company." />
      ) : candidates.loading && !candidates.state ? (
        <LoadingState what="Mapping people to this account" visual={<RelationshipGraph accent={engine.accent} />} />
      ) : candidates.error ? (
        // Not "no people": no answer. The account map and its four zeros are
        // withheld deliberately — drawing them here is how a broken endpoint
        // was reported as a verified fact about this company.
        <ErrorState
          error={candidates.error}
          what="This company’s decision makers could not be read"
          affects={faultAffects(candidates.error)}
          onRetry={candidates.refresh}
        />
      ) : candidates.absent ? (
        // The endpoint answered, and what it said is that discovery has not
        // completed here yet. Its sentence is rendered verbatim rather than
        // reworded into "no candidates found", which would be a different and
        // untrue claim.
        <EmptyState
          title="Discovery has not run for this company"
          detail={candidates.absent}
          icon={Users}
          action={discover || undefined}
        />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel title="Account map">
                <div className="viz">
                  <RelationshipGraph accent={engine.accent} count={rows.length} />
                  {rows.length === 0 && (
                    <div className="viz__empty">
                      <p>No people have been verified for this company.</p>
                    </div>
                  )}
                </div>
                <MetricRow>
                  <Metric label="People seen" value={peopleSeen} size="sm" />
                  <Metric label="Shortlisted" value={shortlisted.length} accent size="sm" />
                  <Metric label="Set aside" value={setAside} size="sm" />
                  <Metric label="With an email" value={withEmail} size="sm" />
                  <Metric label="With a phone" value={withPhone} size="sm" />
                </MetricRow>
              </Panel>

              {shortlisted.length === 0 ? (
                <EmptyState
                  title="Nobody verified yet"
                  detail={
                    aside.length
                      ? `The search found ${aside.length} ${aside.length === 1 ? 'person' : 'people'}, but no source ties ${
                          aside.length === 1 ? 'them' : 'any of them'
                        } to this company in a relevant role. They are listed below with the reason. The engine will not present an unverified person as a decision maker.`
                      : 'No decision maker has been discovered for this company. The engine will not invent one — a name it cannot reference is not recorded.'
                  }
                />
              ) : (
                <Panel title="Candidates" subtitle="Every person the engine could actually verify">
                  <ul className="people">
                    {shortlisted.map((c, i) => (
                      <li key={c.id} className="people__card node-reveal" style={{ ['--i' as string]: i, ['--e' as string]: engine.accent }}>
                        <span className="people__avatar" aria-hidden="true">
                          {c.fullName.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="people__body">
                          <div className="people__head">
                            <span className="people__name">{c.fullName}</span>
                            {c.outcome === 'shortlisted' ? (
                              <Chip tone="ok">Shortlisted</Chip>
                            ) : (
                              <Chip>{c.outcome.replace(/_/g, ' ')}</Chip>
                            )}
                            {c.contactRole === 'primary' && <Chip tone="accent">Primary contact</Chip>}
                            {c.contactRole === 'alternative' && <Chip tone="info">Alternative contact</Chip>}
                          </div>
                          <p className="people__title">{c.rawTitle ?? <Unset what="Title not stated" />}</p>
                          <div className="row">
                            {c.roleGroup && <Chip tone="accent">{c.roleGroup.replace(/_/g, ' ')}</Chip>}
                            <Chip tone={c.confidence === 'high' ? 'ok' : c.confidence === 'medium' ? 'warn' : 'neutral'}>
                              {c.confidence} confidence
                            </Chip>
                            <Chip tone={c.contactability === 'none' ? 'neutral' : 'info'}>
                              {c.contactability.replace(/_/g, ' ')}
                            </Chip>
                          </div>
                          {/* Contact detail, or an explicit absence. Three
                              routes to a person, each either a value a source
                              stated or a plain statement that none did — a
                              "profile only" chip beside no visible profile
                              made the reader open the drawer to find out
                              whether one existed. */}
                          <div className="people__contact">
                            {/* THE EMAIL, AND WHERE IT CAME FROM.
                                "No email address recorded" was printed for
                                four situations needing four different
                                actions: an address that names this person, a
                                shared mailbox that is nobody's, addresses
                                naming somebody else, and no provider
                                authorised to look. The server derives which
                                one it is from evidence it already holds, so
                                this line reads it rather than guessing. */}
                            <span>
                              {c.email ? (
                                <>
                                  <a href={`mailto:${c.email}`}>{c.email}</a>
                                  {c.emailContact?.sourceLabel && (
                                    <span className="people__src">
                                      {' '}
                                      — linked to {c.fullName} · source: {c.emailContact.sourceLabel}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <Unset
                                  what={
                                    c.emailContact?.note ??
                                    'No verified person email found. Nothing was guessed from the name or the domain.'
                                  }
                                />
                              )}
                            </span>
                            <span>{c.phone ?? <Unset what="No phone number recorded" />}</span>
                            <span>
                              {c.profileUrl ? (
                                <a href={c.profileUrl} target="_blank" rel="noopener noreferrer">
                                  {profileLabel(c.profileUrl)}
                                </a>
                              ) : (
                                <Unset what="No public profile recorded" />
                              )}
                            </span>
                          </div>
                        </div>
                        <EvidenceButton
                          title={c.fullName}
                          items={[
                            {
                              what: `${c.fullName}${c.rawTitle ? ` — ${c.rawTitle}` : ''}`,
                              source: evidenceSourceLabel(c),
                              sourceUrl: c.profileUrl,
                              field: c.roleGroup ?? undefined,
                              how: `Company match: ${c.companyMatch.replace(/_/g, ' ')}. Confidence: ${c.confidence}.`,
                              reference: c.id,
                            },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}

              {/* WHAT THE SEARCH TURNED UP THAT IS NOT A DECISION MAKER.
                  Shown because "2 set aside" as a number tells a reader
                  nothing they can check, and named people with their reason
                  and their source can be checked in a second. Deliberately a
                  separate panel with its own words: these are not candidates,
                  and nothing here may be approached. */}
              {aside.length > 0 && (
                <Panel
                  title="Found but set aside"
                  subtitle={`${aside.length} ${aside.length === 1 ? 'person' : 'people'} a source named, grouped by the reason each was not shortlisted`}
                >
                  {asideGroups(aside).map((group) => (
                    <section key={group.key} className="aside__group">
                      <header className="aside__grouphead">
                        <span className="aside__groupname">{group.heading}</span>
                        <span className="aside__groupcount">{group.people.length}</span>
                      </header>
                      <p className="aside__groupwhy">{group.detail}</p>
                      <ul className="aside">
                        {group.people.map((c) => (
                          <li key={c.id} className="aside__row">
                            <div className="aside__who">
                              {/* The exact sentence the run recorded stays reachable,
                                  without repeating a paragraph of it on every row. */}
                              <span className="aside__name" title={c.exclusionReason ?? undefined}>
                                {c.fullName}
                              </span>
                              {c.rawTitle && (
                                <span className="aside__title" title={c.rawTitle}>
                                  {c.rawTitle}
                                </span>
                              )}
                            </div>
                            <div className="aside__meta">
                              <Chip>{evidenceSourceLabel(c)}</Chip>
                              {evidenceUrl(c) && (
                                <a className="aside__link" href={evidenceUrl(c)!} target="_blank" rel="noopener noreferrer">
                                  Where this was read
                                </a>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                  <p className="note aside__foot">
                    Recorded, not proposed. Outreach never uses anyone here, and a person moves up only once a source
                    states that they work at this company in a relevant role.
                  </p>
                </Panel>
              )}
            </>
          }
          side={
            <>
              <Panel title="Contactability">
                <MetricRow>
                  <Metric label="Emails" value={withEmail} size="sm" />
                  <Metric label="Phones" value={withPhone} size="sm" />
                </MetricRow>
                {rows.length > 0 && withEmail === 0 && withPhone === 0 && withheld > 0 && (
                  <BlockedState
                    what="Contact details are withheld by policy"
                    why={`A source stated contact details for ${withheld} of these people, but DM_STORE_CONTACT_DATA is off, so they were not stored. This is a policy decision, not a data gap.`}
                    affects="The email and LinkedIn outreach channels have no stored destination for this company."
                    remediation="Enable DM_STORE_CONTACT_DATA if storing contact details is approved, then run the search again."
                  />
                )}
                {rows.length > 0 && withEmail === 0 && withPhone === 0 && withheld === 0 && (
                  <BlockedState
                    what="No contact details are available"
                    why="The engine verified these people but no source stated an email address or a phone number for any of them. It will not infer one from a name and a domain."
                    affects="The email and LinkedIn outreach channels have no destination for this company."
                    remediation="Configure a contact-data provider, or supply contact details another way."
                  />
                )}
              </Panel>

              <Panel title="Provider status" subtitle="Every source this run asked, in the order it asked them">
                {providers.length === 0 ? (
                  <p className="note">
                    Contact enrichment providers are configured at the platform level. Where none is authorised, this
                    engine reports what it could verify from the CRM and public pages alone.
                  </p>
                ) : (
                  <div className="stack">
                    {providers.map((p) => {
                      const label = providerStatusLabel(p)
                      return (
                        <div key={p.provider} className="prov-row">
                          <span className="prov-row__name">{PROVIDER_LABEL[p.provider] ?? p.provider.replace(/_/g, ' ')}</span>
                          <Chip tone={label.tone}>{label.text}</Chip>
                          {p.reason && <ProviderNote text={p.reason} />}
                        </div>
                      )
                    })}
                  </div>
                )}
              </Panel>
            </>
          }
        />
      )}
    </EnginePage>
  )
}

/**
 * What a failed read costs the reader, said so it cannot be mistaken for a
 * result about the company.
 *
 * The status is named because the two 404s mean opposite things: one carries
 * the API's own envelope and means discovery has not run, which is handled as
 * an absence and never reaches here; one carries nothing, and means the route
 * is not mounted or something else replied in the API's place.
 */
function faultAffects(error: Error | ApiError): string {
  const api = error instanceof ApiError ? error : null
  if (!api) {
    return 'Nothing is known about this company’s people. This is not a count of zero.'
  }
  if (api.isMissingRoute) {
    return (
      `The endpoint answered ${api.status} without an application response, so the route is not mounted or ` +
      'something else replied in the API’s place. Nothing is known about this company’s people — in particular, ' +
      'not that there are none.'
    )
  }
  if (api.status === 0) {
    return 'Nothing is known about this company’s people — in particular, not that there are none.'
  }
  return (
    `The request failed with status ${api.status}. Nothing is known about this company’s people — in particular, ` +
    'not that there are none.'
  )
}
