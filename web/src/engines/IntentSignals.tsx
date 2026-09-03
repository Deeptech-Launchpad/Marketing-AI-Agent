import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, Unset } from '../components/ui/primitives'
import { EmptyState, LoadingState } from '../components/ui/states'
import { SignalWave } from '../components/motion/Signatures'
import { DataTable } from '../components/ui/DataTable'
import { EvidenceButton } from '../components/ui/Evidence'
import type { IntentSignal } from '../lib/types'

// Intent Signals (#977).
//
// Signals come from the CRM, careers pages and job boards. Each carries the
// source that produced it and a confidence the backend assigned — the
// interface reports both and computes neither.

export function IntentSignals() {
  const engine = useEngine('intent')
  const { company } = useCompany()
  const id = company?.crmCompanyId

  const signals = useAsync<{ signals: IntentSignal[] }>(
    (signal) => api.get(`/intent/companies/${id}/signals`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )

  const rows = signals.data?.signals ?? []
  const byCategory = rows.reduce<Record<string, number>>((acc, s) => {
    acc[s.signalCategory] = (acc[s.signalCategory] ?? 0) + 1
    return acc
  }, {})

  return (
    <EnginePage engineId="intent" state={rows.length ? 'success' : 'idle'} signature={<SignalWave accent={engine.accent} />}>
      {!company ? (
        <EmptyState title="Select a company" detail="Intent signals are collected per company." />
      ) : signals.loading && !signals.data ? (
        <LoadingState what="Listening for intent signals" visual={<SignalWave accent={engine.accent} />} />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel title="Signal activity">
                <div className="viz viz--short">
                  <SignalWave accent={engine.accent} label="Intent signal waveform" />
                </div>
                <MetricRow>
                  <Metric label="Signals" value={rows.length} accent size="sm" />
                  <Metric label="Active" value={rows.filter((s) => s.status === 'active').length} size="sm" />
                  <Metric label="Categories" value={Object.keys(byCategory).length} size="sm" />
                </MetricRow>
              </Panel>

              <Panel title="Detected signals" padded={false}>
                {rows.length === 0 ? (
                  <EmptyState
                    title="No signals detected"
                    detail="Nothing has been observed for this company yet. Intent detection reads the CRM, careers pages and job boards, and records only what those sources actually stated."
                  />
                ) : (
                  <DataTable
                    rows={rows}
                    rowKey={(r) => r.id}
                    columns={[
                      { key: 'when', header: 'Detected', render: (r) => <span className="mono cell-dim">{new Date(r.detectedAt).toLocaleDateString()}</span> },
                      { key: 'cat', header: 'Source', render: (r) => <Chip tone="accent">{r.signalCategory}</Chip> },
                      { key: 'summary', header: 'Signal', render: (r) => <span className="cell-strong">{r.summary}</span> },
                      {
                        key: 'confidence',
                        header: 'Confidence',
                        render: (r) => (
                          <Chip tone={r.confidence === 'high' ? 'ok' : r.confidence === 'medium' ? 'warn' : 'neutral'}>
                            {r.confidence}
                          </Chip>
                        ),
                      },
                      {
                        key: 'ev',
                        header: '',
                        render: (r) => (
                          <EvidenceButton
                            title={r.summary}
                            items={[
                              {
                                what: r.summary,
                                source: r.signalType,
                                sourceUrl: r.sourceUrl,
                                at: r.detectedAt,
                                how: `Detected with ${r.confidence} confidence.`,
                                reference: r.id,
                              },
                            ]}
                          />
                        ),
                      },
                    ]}
                  />
                )}
              </Panel>
            </>
          }
          side={
            <Panel title="By source">
              {Object.keys(byCategory).length === 0 ? (
                <Unset what="Nothing detected" />
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
          }
        />
      )}
    </EnginePage>
  )
}
