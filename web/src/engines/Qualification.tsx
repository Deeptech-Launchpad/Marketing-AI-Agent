import { useState } from 'react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import { EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Chip, ProvisionalChip, Button, Field, Unset, StatusBadge, toUiStatus } from '../components/ui/primitives'
import { BlockedState, EmptyState, LoadingState } from '../components/ui/states'
import { ThresholdMeter } from '../components/ui/ScoreRing'
import { EvidenceButton } from '../components/ui/Evidence'
import type { Qualification as Q, QualificationPolicy, QualificationTransition } from '../lib/types'
import { prettyEvent } from './IntentScoring'
import { Play, RotateCw } from 'lucide-react'

// Sales Qualification (#985).
//
// Three statuses are shown separately because the backend keeps them separate:
// whether the lead qualified, whether a person was actually told, and whether
// a task exists. "Qualified, alert skipped, task skipped" is a real state, and
// collapsing it would hide that nobody has been notified.

export function Qualification() {
  const { company } = useCompany()
  const { can } = useAuth()
  const [busy, setBusy] = useState<string | null>(null)
  const id = company?.crmCompanyId

  const qual = useAsync<Q | null>(
    (signal) => (id ? api.get(`/sales-qualification/companies/${id}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )
  const detail = useAsync<Q | null>(
    (signal) => (qual.data?.id ? api.get(`/sales-qualification/${qual.data.id}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [qual.data?.id],
    { enabled: Boolean(qual.data?.id) },
  )
  const history = useAsync<{ transitions: QualificationTransition[] }>(
    (signal) => api.get(`/sales-qualification/companies/${id}/history`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )
  const policy = useAsync<QualificationPolicy>(
    (signal) => api.get('/sales-qualification/policies/sq1-provisional', { signal }),
    [],
  )

  const run = async (what: 'evaluate' | 'retry') => {
    if (!id) return
    setBusy(what)
    try {
      if (what === 'evaluate') await api.post('/sales-qualification/evaluate', { crmCompanyId: id })
      else if (qual.data?.id) await api.post(`/sales-qualification/${qual.data.id}/retry-actions`)
      qual.refresh()
      detail.refresh()
      history.refresh()
    } finally {
      setBusy(null)
    }
  }

  if (!company) {
    return (
      <EnginePage engineId="qualification">
        <EmptyState title="Select a company" detail="Qualification is evaluated per company." />
      </EnginePage>
    )
  }

  const q = detail.data ?? qual.data
  const qualified = q?.status === 'qualified' || q?.status === 'qualified_unassigned'

  return (
    <EnginePage
      engineId="qualification"
      state={busy ? 'running' : qualified ? 'success' : 'idle'}
      actions={
        can('operate') && (
          <Button icon={Play} onClick={() => run('evaluate')} busy={busy === 'evaluate'}>
            Evaluate
          </Button>
        )
      }
    >
      {qual.loading && !qual.data ? (
        <LoadingState what="Comparing the intent score to the threshold" />
      ) : !q?.evaluated && !q?.status ? (
        <EmptyState
          title="Not evaluated yet"
          detail="This company has not been measured against the qualification threshold. Run an evaluation to compare its current intent score."
          action={can('operate') ? <Button variant="primary" icon={Play} onClick={() => run('evaluate')}>Evaluate now</Button> : undefined}
        />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel
                title="Threshold decision"
                subtitle={`${q.qualificationPolicyVersion} · engine ${q.qualificationEngineVersion}`}
                actions={<ProvisionalChip what="Provisional threshold" />}
              >
                <ThresholdMeter
                  score={q.intentScore ?? 0}
                  threshold={q.threshold ?? 0}
                  qualified={Boolean(qualified)}
                />
                <p className="note" style={{ marginTop: 'var(--s5)', textAlign: 'center' }}>
                  {q.reason}
                </p>
              </Panel>

              {/* Why, referencing #984 contributions rather than restating them. */}
              {q.whyQualified && q.whyQualified.keyObservedActions.length > 0 && (
                <Panel title="Why this lead qualified" subtitle="The strongest observed acts behind the score">
                  <ul className="why">
                    {q.whyQualified.keyObservedActions.map((a, i) => (
                      <li key={a.engagementEventId} className="why__item node-reveal" style={{ ['--i' as string]: i }}>
                        <span className="why__points tnum">+{a.contribution}</span>
                        <span className="why__body">
                          <span className="why__what">{prettyEvent(a.eventType)}</span>
                          <span className="why__when mono">{new Date(a.occurredAt).toLocaleString()}</span>
                        </span>
                        <EvidenceButton
                          title={prettyEvent(a.eventType)}
                          label="Event"
                          items={[
                            {
                              what: `Contributed ${a.contribution} points to the intent score.`,
                              source: a.channel,
                              at: a.occurredAt,
                              reference: a.engagementEventId,
                              how: 'Recorded by the engagement engine and scored by the intent scoring engine.',
                            },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}

              {/* The three statuses, deliberately apart. */}
              <div className="grid-3">
                <Panel title="Qualification">
                  <StatusBadge status={toUiStatus(q.status)} label={pretty(q.status)} />
                  <p className="note" style={{ marginTop: 'var(--s3)' }}>
                    {q.qualifiedAt ? `Since ${new Date(q.qualifiedAt).toLocaleString()}` : 'Not currently qualified.'}
                  </p>
                </Panel>

                <Panel title="Sales alert">
                  <StatusBadge status={toUiStatus(q.alert?.status)} label={pretty(q.alert?.status)} />
                  {q.alerts?.[0]?.reason && <p className="note" style={{ marginTop: 'var(--s3)' }}>{q.alerts[0].reason}</p>}
                </Panel>

                <Panel title="Follow-up task">
                  <StatusBadge status={toUiStatus(q.followUp?.status)} label={pretty(q.followUp?.status)} />
                  {q.followUp?.dueAt && (
                    <p className="note" style={{ marginTop: 'var(--s3)' }}>
                      Due {new Date(q.followUp.dueAt).toLocaleString()}
                    </p>
                  )}
                </Panel>
              </div>

              {/* Unowned leads are the live blocker on this installation. */}
              {q.status === 'qualified_unassigned' && (
                <BlockedState
                  what="This lead has no sales owner"
                  why={
                    q.owner?.reason ??
                    'No account owner is set on the company in NXT Sales, and no fallback owner or sales queue is configured.'
                  }
                  affects="The alert and the follow-up task were both skipped, so nobody has been told about this lead."
                  remediation="Set an account owner in NXT Sales, or configure a fallback owner or sales queue."
                  action={
                    can('operate') && (
                      <Button icon={RotateCw} onClick={() => run('retry')} busy={busy === 'retry'}>
                        Retry handoff
                      </Button>
                    )
                  }
                />
              )}
            </>
          }
          side={
            <>
              <Panel title="Owner">
                <Field label="Assigned to" value={q.owner?.name ?? <Unset what="Unassigned" />} />
                <Field label="Source" value={pretty(q.owner?.source)} />
                {q.owner?.reason && <p className="note" style={{ marginTop: 'var(--s3)' }}>{q.owner.reason}</p>}
              </Panel>

              <Panel title="Decision snapshot" subtitle="Frozen, so the decision stays explainable">
                <Field label="Score at qualification" value={q.intentScore} />
                <Field label="Threshold applied" value={q.threshold} />
                <Field label="Above threshold" value={q.aboveThreshold} />
                <Field label="Score policy" value={q.scorePolicyVersion} mono />
                <Field label="Calculation" value={q.scoreCalculationVersion} mono />
                <Field label="Evaluations" value={q.evaluationCount} />
              </Panel>

              <Panel title="History" subtitle="Append-only">
                {history.data?.transitions.length ? (
                  <ol className="history">
                    {history.data.transitions.map((t, i) => (
                      <li key={t.id} className="history__item node-reveal" style={{ ['--i' as string]: i }}>
                        <span className="history__score tnum">{t.score}</span>
                        <span className="history__meta">
                          <span className="history__when mono">{new Date(t.occurredAt).toLocaleString()}</span>
                          <span className="history__trigger">
                            {t.from ? `${pretty(t.from)} → ${pretty(t.to)}` : pretty(t.to)}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Unset what="No transitions recorded" />
                )}
              </Panel>

              {policy.data && (
                <Panel title="Policy">
                  <Field label="Threshold" value={<><span className="tnum">{policy.data.threshold}</span> <ProvisionalChip /></>} />
                  <Field label="SLA" value={`${policy.data.slaMinutes} minutes`} />
                  <Field label="Hysteresis band" value={policy.data.deQualifyBand === 0 ? 'None' : policy.data.deQualifyBand} />
                  <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>
                    {policy.data.notes[0]}
                  </p>
                  {policy.data.providers && (
                    <>
                      <p className="note" style={{ marginTop: 'var(--s4)' }}>Alert providers</p>
                      <div className="row">
                        {policy.data.providers.alert.map((p) => (
                          <Chip key={p.name} tone={p.status === 'available' ? 'ok' : 'warn'} title={p.reason}>
                            {p.name}
                          </Chip>
                        ))}
                      </div>
                    </>
                  )}
                </Panel>
              )}
            </>
          }
        />
      )}
    </EnginePage>
  )
}

function pretty(s: string | null | undefined): string {
  if (!s) return '—'
  return s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}
