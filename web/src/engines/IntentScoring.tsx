import { useState } from 'react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, ProvisionalChip, Button, Unset } from '../components/ui/primitives'
import { AsyncBoundary, BlockedState, EmptyState, LoadingState } from '../components/ui/states'
import { ScoreRing } from '../components/ui/ScoreRing'
import { SignalWave } from '../components/motion/Signatures'
import { DataTable } from '../components/ui/DataTable'
import { EvidenceButton } from '../components/ui/Evidence'
import type { ScoreBreakdown, ScoreContribution, ScoreSnapshot, ScoringPolicy } from '../lib/types'
import { RefreshCw } from 'lucide-react'

// Intent Scoring (#984).
//
// The score is consumed, never computed here. Every point on screen carries
// the engagement event that produced it, which is the whole reason the
// backend stores contributions rather than a total.

export function IntentScoring() {
  const engine = useEngine('scoring')
  const { company } = useCompany()
  const { can } = useAuth()
  const [recalculating, setRecalculating] = useState(false)
  const id = company?.crmCompanyId

  const breakdown = useAsync<ScoreBreakdown | null>(
    (signal) =>
      id ? api.get<ScoreBreakdown>(`/intent-score/companies/${id}/breakdown`, { signal, nullOn404: true }) : Promise.resolve(null),
    [id],
    { enabled: Boolean(id) },
  )
  const history = useAsync<{ snapshots: ScoreSnapshot[] }>(
    (signal) => api.get(`/intent-score/companies/${id}/history?limit=20`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )
  const policy = useAsync<ScoringPolicy>(
    (signal) => api.get('/intent-score/policies/v1-provisional', { signal }),
    [],
  )

  const recalculate = async () => {
    if (!id) return
    setRecalculating(true)
    try {
      await api.post('/intent-score/recalculate', { crmCompanyId: id })
      breakdown.refresh()
      history.refresh()
    } finally {
      setRecalculating(false)
    }
  }

  if (!company) {
    return (
      <EnginePage engineId="scoring">
        <EmptyState title="Select a company" detail="Intent scores are calculated per company." />
      </EnginePage>
    )
  }

  return (
    <EnginePage
      engineId="scoring"
      state={recalculating ? 'running' : breakdown.data ? 'success' : 'idle'}
      signature={<SignalWave accent={engine.accent} />}
      actions={
        can('operate') && (
          <Button icon={RefreshCw} onClick={recalculate} busy={recalculating}>
            Recalculate
          </Button>
        )
      }
    >
      {breakdown.loading && !breakdown.data ? (
        <LoadingState what="Reading the score and its contributions" visual={<SignalWave accent={engine.accent} />} />
      ) : !breakdown.data ? (
        <EmptyState
          title="No score yet"
          detail={`${company.companyName ?? 'This company'} has no recorded engagement to score. A score appears once the prospect interacts with something the platform published.`}
        />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel title="Score" subtitle={`Policy ${breakdown.data.policyVersion} · calculation ${breakdown.data.calculationVersion}`}>
                <div className="score-hero">
                  <ScoreRing
                    score={breakdown.data.score}
                    max={breakdown.data.scoreRange.max}
                    level={breakdown.data.level}
                    accent={engine.accent}
                  />
                  <div className="score-hero__side">
                    <MetricRow>
                      <Metric label="Raw total" value={breakdown.data.rawScore} size="sm" />
                      <Metric label="Counted" value={breakdown.data.totals.counted} size="sm" />
                      <Metric label="Set aside" value={breakdown.data.totals.setAside} size="sm" />
                    </MetricRow>

                    {breakdown.data.clamped && (
                      <p className="note">
                        The raw total of {breakdown.data.rawScore} was bounded to {breakdown.data.scoreRange.max}. Both
                        numbers are kept, so the normalisation is visible rather than hidden.
                      </p>
                    )}

                    <div className="row">
                      <Chip tone={breakdown.data.contactability.status === 'blocked' ? 'danger' : breakdown.data.contactability.status === 'degraded' ? 'warn' : 'ok'}>
                        Contactability: {breakdown.data.contactability.status}
                      </Chip>
                      {breakdown.data.policyStatus === 'provisional' && <ProvisionalChip what="Provisional weights" />}
                    </div>

                    <p className="note note--caveat">{breakdown.data.note}</p>
                  </div>
                </div>
              </Panel>

              {/* Every counted point, with the event behind it. */}
              <Panel title="What produced this score" subtitle="Each line names the engagement event it came from" padded={false}>
                <DataTable
                  rows={breakdown.data.contributions}
                  rowKey={(r) => r.engagementEventId + r.policyRuleId}
                  columns={[
                    { key: 'event', header: 'Observed act', render: (r) => <span className="cell-strong">{prettyEvent(r.eventType)}</span> },
                    { key: 'channel', header: 'Channel', render: (r) => <Chip>{r.channel}</Chip> },
                    { key: 'when', header: 'When', render: (r) => <span className="mono cell-dim">{new Date(r.occurredAt).toLocaleString()}</span> },
                    { key: 'base', header: 'Base', numeric: true, render: (r) => r.basePoints },
                    { key: 'fresh', header: 'Freshness', numeric: true, render: (r) => `×${r.freshnessMultiplier}` },
                    {
                      key: 'points',
                      header: 'Points',
                      numeric: true,
                      render: (r) => (
                        <span style={{ color: r.contribution >= 0 ? engine.accent : 'var(--danger)', fontWeight: 600 }}>
                          {r.contribution > 0 ? `+${r.contribution}` : r.contribution}
                        </span>
                      ),
                    },
                    {
                      key: 'evidence',
                      header: '',
                      render: (r) => (
                        <EvidenceButton
                          title={prettyEvent(r.eventType)}
                          label="Event"
                          items={[
                            {
                              what: r.reason,
                              field: r.policyRuleId,
                              at: r.occurredAt,
                              reference: r.engagementEventId,
                              how: `Scored under policy ${r.scoringPolicyVersion}. ${r.freshnessLabel}.`,
                            },
                          ]}
                        />
                      ),
                    },
                  ]}
                />
              </Panel>

              {/* The events that contributed nothing, and why — this is where
                  "why isn't it higher" is actually answered. */}
              {breakdown.data.setAside.length > 0 && (
                <Panel
                  title="Set aside"
                  subtitle={`${breakdown.data.setAside.length} event(s) were considered and contributed nothing`}
                  padded={false}
                >
                  {/* Grouped by reason. This company has 200-odd events that
                      were set aside for the identical reason, and printing
                      that sentence 200 times would bury the two that are
                      actually interesting. The counts are stated, so nothing
                      is hidden by the grouping. */}
                  <DataTable
                    rows={groupSetAside(breakdown.data.setAside)}
                    rowKey={(r) => r.key}
                    columns={[
                      { key: 'count', header: 'Events', numeric: true, render: (r) => r.count },
                      { key: 'event', header: 'Act', render: (r) => <span className="cell-strong">{prettyEvent(r.eventType)}</span> },
                      { key: 'reason', header: 'Why it did not count', render: (r) => <span className="cell-dim">{r.reason}</span> },
                    ]}
                  />
                </Panel>
              )}
            </>
          }
          side={
            <>
              <Panel title="How it moved">
                <AsyncBoundary
                  state={history}
                  what="Reading score history"
                  isEmpty={(d) => d.snapshots.length === 0}
                  empty={<EmptyState title="No history yet" detail="A snapshot is recorded each time the score changes." />}
                >
                  {(d) => (
                    <ol className="history">
                      {d.snapshots.map((s, i) => (
                        <li key={s.snapshotId} className="history__item node-reveal" style={{ ['--i' as string]: i }}>
                          <span className="history__score tnum" style={{ color: engine.accent }}>
                            {s.score}
                          </span>
                          <span className="history__meta">
                            <span className="history__when mono">{new Date(s.evaluatedAt).toLocaleString()}</span>
                            <span className="history__trigger">{s.trigger.replace(/_/g, ' ')}</span>
                          </span>
                          {s.change !== null && s.change !== 0 && (
                            <span className={`history__delta ${s.change > 0 ? 'is-up' : 'is-down'}`}>
                              {s.change > 0 ? `+${s.change}` : s.change}
                            </span>
                          )}
                        </li>
                      ))}
                    </ol>
                  )}
                </AsyncBoundary>
              </Panel>

              <Panel title="Scoring policy">
                {policy.data ? (
                  <>
                    <div className="row" style={{ marginBottom: 'var(--s3)' }}>
                      <Chip tone="accent">{policy.data.version}</Chip>
                      {policy.data.status === 'provisional' && <ProvisionalChip />}
                    </div>
                    <p className="note">Freshness bands</p>
                    <ul className="bands">
                      {policy.data.decayBands.map((b) => (
                        <li key={b.label}>
                          <span className="mono">
                            {b.fromDays}–{b.toDays ?? '∞'}d
                          </span>
                          <span>×{b.multiplier}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="note" style={{ marginTop: 'var(--s3)' }}>
                      Levels
                    </p>
                    <ul className="bands">
                      {policy.data.levelBands.map((b) => (
                        <li key={b.level}>
                          <span>{b.level}</span>
                          <span className="mono">
                            {b.fromScore}–{b.toScore}
                          </span>
                        </li>
                      ))}
                    </ul>
                    <BlockedState
                      what="These weights are not business-approved"
                      why={policy.data.notes[0] ?? 'The scoring weights are a provisional default.'}
                      affects="Every score, and the qualification threshold measured against it."
                      remediation="Sign off the weights, or publish a new policy version with agreed values."
                    />
                  </>
                ) : (
                  <Unset what="Policy unavailable" />
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
 * Collapses set-aside contributions that share an act and a reason.
 *
 * Keeps the total honest by carrying the count, and keeps the panel readable
 * by not repeating one sentence two hundred times.
 */
function groupSetAside(rows: ScoreContribution[]) {
  const groups = new Map<string, { key: string; eventType: string; reason: string; count: number }>()
  for (const r of rows) {
    const key = `${r.eventType}|${r.reason}`
    const existing = groups.get(key)
    if (existing) existing.count++
    else groups.set(key, { key, eventType: r.eventType, reason: r.reason, count: 1 })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

/** Turns an event type into something a salesperson reads. */
export function prettyEvent(type: string): string {
  return type
    .replace(/^workbench_/, '')
    .replace(/^audit_report_/, 'report ')
    .replace(/^outreach_action_/, 'outreach ')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
}
