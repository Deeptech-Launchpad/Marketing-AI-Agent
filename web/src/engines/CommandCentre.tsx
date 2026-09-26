import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PIPELINE, numberWord, rgbTriple } from '../lib/engines'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import type { EngagementEvent } from '../lib/types'
import { AgentMark } from '../components/agent/AgentMark'
import { StatusDot, Unset } from '../components/ui/primitives'
import { EmptyState } from '../components/ui/states'
import { LOCKED_HEADLINE } from '../components/ui/LockedEngine'
import type { UiStatus } from '../lib/types'
import './command.css'

// ─────────────────────────────────────────────────────────────────────────
// The Command Centre.
//
// The pipeline is the story, not a wall of counters. One node per engine, in flow
// order, each showing whether that stage has actually run for the company in
// context — so the first thing anyone sees is where the work has reached and
// where it stopped.
//
// A node's state is read from the engine that owns it. Where an engine has no
// record for this company the node reads "Not started", which is the truth,
// rather than a zero that looks like a measurement.
//
// THREE NODES ARE LOCKED FOR THE CURRENT PHASE.
//
// Intent Score, Sales Qualification and CRM Handoff are withheld on their own
// screens while their weights and threshold are unapproved. This board is the
// first screen of the demo and it was reporting the same values in miniature —
// "100 / 100 · HIGH", "Qualified", "Prepared, held" — which would have made
// the lock on the other screens pointless. Those three nodes now read the same
// sentence as everywhere else, and their endpoints are not called from here.
//
// Engagement is NOT locked: the timeline is real, checkable and still linked.
// What is withheld is its AGGREGATE — this board printed "19 prospect acts"
// from the summary endpoint, and a bare count of acts is the number that could
// not be defended. The node links to the acts themselves instead.
// ─────────────────────────────────────────────────────────────────────────

interface StageState {
  status: UiStatus
  detail: string | null
}

export function CommandCentre() {
  const { company } = useCompany()
  const { principal } = useAuth()
  const id = company?.crmCompanyId

  // ONE read. The score, qualification and CRM reads are gone rather than
  // conditioned, for the same reason they are gone from their own screens: a
  // value fetched in order not to draw it can still surface through a loading
  // state, an error quoting the response, or a network tab open on a
  // projector.
  //
  // Engagement asks for the EVENTS, not the summary. The board needs to know
  // whether anything has been observed; it does not need — and could not
  // defend — a count.
  const engagement = useAsync<{ events: EngagementEvent[] } | null>(
    (signal) =>
      id
        ? api.get<{ events: EngagementEvent[] }>(`/engagement/companies/${id}/timeline?limit=1`, {
            signal,
            nullOn404: true,
          })
        : Promise.resolve(null),
    [id],
    { enabled: Boolean(id) },
  )

  const stageState = (engineId: string): StageState => {
    switch (engineId) {
      case 'enrichment':
        return company
          ? { status: 'complete', detail: `${company.technologyCount ?? 0} detected` }
          : { status: 'idle', detail: null }
      case 'engagement': {
        // Whether anything was observed, never how much.
        const observed = (engagement.data?.events?.length ?? 0) > 0
        return observed ? { status: 'complete', detail: 'Acts recorded' } : { status: 'idle', detail: null }
      }
      // Locked: the node says so rather than reporting a withheld value as
      // "Not started", which would be a different and untrue claim.
      case 'crm':
        return { status: 'idle', detail: LOCKED_HEADLINE }
      default:
        // Prospect, intent, decision makers and outreach are per-run rather
        // than per-company: the command centre links to them rather than
        // inventing a state.
        return { status: 'idle', detail: null }
    }
  }

  const loading = engagement.loading

  return (
    <div className="cc">
      <header className="cc__hero">
        <div>
          <p className="eyebrow">AltiusNXT Marketing AI</p>
          <h1 className="cc__title">
            One platform.
            <br />
            {numberWord(PIPELINE.length).replace(/^./, (c) => c.toUpperCase())} specialised engines.
          </h1>
          <p className="cc__sub">
            {principal ? `Signed in as ${principal.name}. ` : ''}
            Each engine does one job and hands its evidence to the next. Select a company and its context
            follows you the whole way through.
          </p>
        </div>
        <AgentMark state={loading ? 'thinking' : 'idle'} size={54} />
      </header>

      {!company && (
        <EmptyState
          title="No company selected"
          detail="Choose a company in the context panel to see how far it has moved through the pipeline. Only companies the platform has actually worked on appear there."
        />
      )}

      {/* ── The pipeline ────────────────────────────────────────────── */}
      <section className="cc__pipeline" aria-label="Pipeline">
        <div className="cc__rail" aria-hidden="true" />
        <ol className="cc__nodes" style={{ ['--nodes' as string]: PIPELINE.length }}>
          {PIPELINE.map((engine, i) => {
            const st = stageState(engine.id)
            const Icon = engine.icon
            return (
              <li
                key={engine.id}
                className="cc__node node-reveal"
                style={{
                  ['--i' as string]: i,
                  ['--e' as string]: engine.accent,
                  ['--e-rgb' as string]: rgbTriple(engine.accent),
                }}
              >
                <Link to={engine.path} className={`cc__hex cc__hex--${st.status}`} title={engine.purpose}>
                  <span className="cc__hexinner">
                    <Icon size={19} aria-hidden="true" />
                  </span>
                  {st.status === 'running' && <span className="cc__ping" aria-hidden="true" />}
                </Link>

                <span className="cc__stagenum mono">{engine.stage}</span>
                <span className="cc__name">{engine.name}</span>

                <span className="cc__state">
                  <StatusDot status={st.status} />
                  <span className="cc__statelabel">
                    {st.detail ?? (company ? 'Not started' : '—')}
                  </span>
                </span>
              </li>
            )
          })}
        </ol>
      </section>

      {/* ── What the platform is waiting on ─────────────────────────── */}
      <section className="cc__panels">
        <article className="cc__panel">
          <p className="eyebrow">Where this company stands</p>
          {!company ? (
            <p className="cc__panel-empty">Select a company to see its position.</p>
          ) : (
            <dl className="cc__dl">
              <dt>Engagement</dt>
              <dd>
                {(engagement.data?.events?.length ?? 0) > 0 ? (
                  // What was observed, not how much of it. The count that
                  // stood here came from the summary endpoint and is the
                  // number this phase withholds.
                  <Link to="/engagement">Acts recorded — open the timeline</Link>
                ) : (
                  <Unset what="Nothing observed yet" />
                )}
              </dd>
              <dt>CRM handoff</dt>
              <dd className="cc__locked">{LOCKED_HEADLINE}</dd>
            </dl>
          )}
        </article>

        <article className="cc__panel">
          <p className="eyebrow">Reading this board</p>
          <ul className="cc__legend">
            <li>
              <StatusDot status="complete" /> The stage has run and produced a result.
            </li>
            <li>
              <StatusDot status="review" /> It produced a result that needs a person.
            </li>
            <li>
              <StatusDot status="blocked" /> It is prepared but something is not configured.
            </li>
            <li>
              <StatusDot status="idle" /> It has not run for this company.
            </li>
          </ul>
          <p className="cc__foot">
            Stages 1 and 3–8 are run per job rather than per company, so they open rather than report here.
          </p>
        </article>
      </section>
    </div>
  )
}
