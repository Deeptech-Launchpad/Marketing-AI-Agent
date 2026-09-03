import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, ChevronDown } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { useCompany } from '../../lib/companyContext'
import type { EngagementSummary, IntentScore, Qualification } from '../../lib/types'
import { Chip, StatusBadge, Unset, toUiStatus } from '../ui/primitives'
import './shell.css'

// ─────────────────────────────────────────────────────────────────────────
// The shared company context.
//
// One company, followed across all twelve engines. Everything shown here is
// read from the engines that produced it — the score from #984, the
// qualification from #985, the engagement counts from #983. Nothing is
// derived in the browser, and a value the backend does not hold is shown as
// missing rather than filled in.
// ─────────────────────────────────────────────────────────────────────────

export function ContextPanel() {
  const { company, companies, select } = useCompany()
  const [picking, setPicking] = useState(false)

  const id = company?.crmCompanyId

  // Each engine is asked separately, so one slow or empty engine never blanks
  // the panel. A 404 here means "this engine has nothing for this company",
  // which is a legitimate answer rather than a failure.
  const score = useAsync<IntentScore | null>(
    (signal) => (id ? api.get<IntentScore>(`/intent-score/companies/${id}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )
  const qualification = useAsync<Qualification | null>(
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

  const sorted = useMemo(
    () => [...companies].sort((a, b) => (a.companyName ?? '').localeCompare(b.companyName ?? '')),
    [companies],
  )

  return (
    <aside className="context" aria-label="Company context">
      <header className="context__head">
        <p className="eyebrow">Shared context</p>
        <button className="context__picker" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          <span className="context__avatar" aria-hidden="true">
            {(company?.companyName ?? '?').slice(0, 2).toUpperCase()}
          </span>
          <span className="context__name">{company?.companyName ?? 'Select a company'}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>

        {picking && (
          <div className="context__menu" role="listbox">
            {sorted.length === 0 && (
              <p className="context__menu-empty">
                No company has been through the pipeline yet. Run enrichment to add one.
              </p>
            )}
            {sorted.map((c) => (
              <button
                key={c.crmCompanyId}
                role="option"
                aria-selected={c.crmCompanyId === id}
                className={`context__menu-item${c.crmCompanyId === id ? ' is-active' : ''}`}
                onClick={() => {
                  select(c)
                  setPicking(false)
                }}
              >
                <span>{c.companyName ?? c.crmCompanyId}</span>
                {c.technologyCount ? <span className="mono context__menu-meta">{c.technologyCount} tech</span> : null}
              </button>
            ))}
          </div>
        )}
      </header>

      {!company ? (
        <div className="context__blank">
          <Building2 size={20} aria-hidden="true" />
          <p>Select a company to carry its context across every engine.</p>
        </div>
      ) : (
        <div className="context__body">
          <section className="context__block">
            <p className="eyebrow">Account</p>
            <dl className="context__dl">
              <dt>Company</dt>
              <dd>{company.companyName ?? <Unset />}</dd>
              <dt>Website</dt>
              <dd>
                {company.sourceUrl ? (
                  <a href={company.sourceUrl} target="_blank" rel="noopener noreferrer">
                    {company.sourceUrl.replace(/^https?:\/\//, '').slice(0, 30)}
                  </a>
                ) : (
                  <Unset />
                )}
              </dd>
              <dt>Technologies</dt>
              <dd className="tnum">{company.technologyCount ?? <Unset what="None detected" />}</dd>
              <dt>CRM id</dt>
              <dd className="mono context__id">{company.crmCompanyId}</dd>
            </dl>
          </section>

          {/* Intent score — read from #984, never recomputed here. */}
          <section className="context__block">
            <p className="eyebrow">Intent</p>
            {score.loading ? (
              <div className="skeleton context__skel" />
            ) : score.data?.scored ? (
              <div className="context__score">
                <span className="context__score-num tnum">{score.data.score}</span>
                <span className="context__score-of">/ {score.data.scoreRange?.max ?? 100}</span>
                <Chip tone={score.data.level === 'HIGH' ? 'ok' : score.data.level === 'MEDIUM' ? 'warn' : 'neutral'}>
                  {score.data.level}
                </Chip>
              </div>
            ) : (
              <Unset what="Not scored yet" />
            )}
            {score.data?.policyStatus === 'provisional' && score.data?.scored && (
              <p className="context__caveat">Provisional weights, not business-approved.</p>
            )}
          </section>

          {/* Qualification — read from #985. */}
          <section className="context__block">
            <p className="eyebrow">Qualification</p>
            {qualification.loading ? (
              <div className="skeleton context__skel" />
            ) : qualification.data?.evaluated ? (
              <>
                <StatusBadge status={toUiStatus(qualification.data.status)} label={formatStatus(qualification.data.status)} />
                <dl className="context__dl context__dl--tight">
                  <dt>Owner</dt>
                  <dd>{qualification.data.owner?.name ?? <Unset what="Unassigned" />}</dd>
                  <dt>Alert</dt>
                  <dd>{formatStatus(qualification.data.alert?.status)}</dd>
                  <dt>Follow-up</dt>
                  <dd>{formatStatus(qualification.data.followUp?.status)}</dd>
                </dl>
              </>
            ) : (
              <Unset what="Not evaluated yet" />
            )}
          </section>

          {/* Engagement — #983 keeps prospect acts apart from ours, and so
              does this panel. Merging them would read as interest we caused. */}
          <section className="context__block">
            <p className="eyebrow">Engagement</p>
            {engagement.loading ? (
              <div className="skeleton context__skel" />
            ) : engagement.data && engagement.data.totalEvents > 0 ? (
              <dl className="context__dl context__dl--tight">
                <dt>By the prospect</dt>
                <dd className="tnum">{engagement.data.prospectEvents}</dd>
                <dt>By AltiusNXT</dt>
                <dd className="tnum">{engagement.data.ourEvents}</dd>
                <dt>Visits</dt>
                <dd className="tnum">{engagement.data.distinctSessions}</dd>
                <dt>Last seen</dt>
                <dd>
                  {engagement.data.lastEventAt ? (
                    <span title={new Date(engagement.data.lastEventAt).toLocaleString()}>
                      {engagement.data.lastEventFreshness}
                    </span>
                  ) : (
                    <Unset />
                  )}
                </dd>
              </dl>
            ) : (
              <Unset what="Nothing observed yet" />
            )}
          </section>

          <Link to="/engagement" className="context__link">
            Open engagement timeline →
          </Link>
        </div>
      )}
    </aside>
  )
}

/** Turns a backend status token into something a person reads. */
function formatStatus(raw: string | null | undefined): string {
  if (!raw) return '—'
  return raw.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}
