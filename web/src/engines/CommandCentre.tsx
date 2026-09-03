import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { PIPELINE, rgbTriple } from '../lib/engines'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import type { EngagementSummary, IntentScore, Qualification, CrmSyncRecord } from '../lib/types'
import { AgentMark } from '../components/agent/AgentMark'
import { StatusDot, Unset } from '../components/ui/primitives'
import { EmptyState } from '../components/ui/states'
import type { UiStatus } from '../lib/types'
import './command.css'

// ─────────────────────────────────────────────────────────────────────────
// The Command Centre.
//
// The pipeline is the story, not a wall of counters. Twelve nodes in flow
// order, each showing whether that stage has actually run for the company in
// context — so the first thing anyone sees is where the work has reached and
// where it stopped.
//
// A node's state is read from the engine that owns it. Where an engine has no
// record for this company the node reads "Not started", which is the truth,
// rather than a zero that looks like a measurement.
// ─────────────────────────────────────────────────────────────────────────

interface StageState {
  status: UiStatus
  detail: string | null
}

export function CommandCentre() {
  const { company } = useCompany()
  const { principal } = useAuth()
  const id = company?.crmCompanyId

  // Four reads cover the stages that can report per-company progress. Each is
  // optional: a company that has not reached a stage simply has no record.
  const score = useAsync<IntentScore | null>(
    (signal) => (id ? api.get<IntentScore>(`/intent-score/companies/${id}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )
  const qual = useAsync<Qualification | null>(
    (signal) =>
      id ? api.get<Qualification>(`/sales-qualification/companies/${id}`, { signal, nullOn404: true }) : Promise.resolve(null),
    [id],
    { enabled: Boolean(id) },
  )
  const engagement = useAsync<EngagementSummary | null>(
    (signal) =>
      id ? api.get<EngagementSummary>(`/engagement/companies/${id}/summary`, { signal, nullOn404: true }) : Promise.resolve(null),
    [id],
    { enabled: Boolean(id) },
  )
  const crm = useAsync<CrmSyncRecord | null>(
    (signal) =>
      qual.data?.id
        ? api.get<CrmSyncRecord>(`/crm-sync/qualifications/${qual.data.id}`, { signal, nullOn404: true })
        : Promise.resolve(null),
    [qual.data?.id],
    { enabled: Boolean(qual.data?.id) },
  )

  const stageState = (engineId: string): StageState => {
    switch (engineId) {
      case 'enrichment':
        return company
          ? { status: 'complete', detail: `${company.technologyCount ?? 0} detected` }
          : { status: 'idle', detail: null }
      case 'engagement': {
        const s = engagement.data
        if (!s || s.totalEvents === 0) return { status: 'idle', detail: null }
        return { status: 'complete', detail: `${s.prospectEvents} prospect acts` }
      }
      case 'scoring': {
        const s = score.data
        if (!s?.scored) return { status: 'idle', detail: null }
        return { status: 'complete', detail: `${s.score} / 100 · ${s.level}` }
      }
      case 'qualification': {
        const q = qual.data
        if (!q?.evaluated) return { status: 'idle', detail: null }
        if (q.status === 'qualified') return { status: 'complete', detail: 'Qualified' }
        if (q.status === 'qualified_unassigned') return { status: 'review', detail: 'Qualified, unassigned' }
        if (q.status === 'de_qualified') return { status: 'error', detail: 'De-qualified' }
        return { status: 'ready', detail: 'Below threshold' }
      }
      case 'crm': {
        const c = crm.data
        if (!c?.prepared) return { status: 'idle', detail: null }
        if (c.state === 'synced') return { status: 'complete', detail: 'Synchronised' }
        if (c.state.startsWith('blocked')) return { status: 'blocked', detail: 'Prepared, held' }
        return { status: 'ready', detail: c.stateLabel }
      }
      default:
        // Prospect, intent, decision makers, audit, report, approval,
        // workbench and outreach are per-run rather than per-company: the
        // command centre links to them rather than inventing a state.
        return { status: 'idle', detail: null }
    }
  }

  const loading = score.loading || qual.loading || engagement.loading

  return (
    <div className="cc">
      <header className="cc__hero">
        <div>
          <p className="eyebrow">AltiusNXT Marketing AI</p>
          <h1 className="cc__title">
            One platform.
            <br />
            Twelve specialised engines.
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
        <ol className="cc__nodes">
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
                {engagement.data && engagement.data.totalEvents > 0 ? (
                  <>
                    <strong className="tnum">{engagement.data.prospectEvents}</strong> prospect actions across{' '}
                    <strong className="tnum">{engagement.data.distinctSessions}</strong> visit(s)
                  </>
                ) : (
                  <Unset what="Nothing observed yet" />
                )}
              </dd>
              <dt>Intent score</dt>
              <dd>
                {score.data?.scored ? (
                  <>
                    <strong className="tnum">{score.data.score}</strong> / 100 — {score.data.level}
                  </>
                ) : (
                  <Unset what="Not scored yet" />
                )}
              </dd>
              <dt>Qualification</dt>
              <dd>
                {qual.data?.evaluated ? (
                  <>
                    {qual.data.status?.replace(/_/g, ' ')} against a threshold of{' '}
                    <strong className="tnum">{qual.data.threshold}</strong>
                  </>
                ) : (
                  <Unset what="Not evaluated yet" />
                )}
              </dd>
              <dt>CRM handoff</dt>
              <dd>{crm.data?.prepared ? crm.data.stateLabel : <Unset what="Not prepared yet" />}</dd>
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
