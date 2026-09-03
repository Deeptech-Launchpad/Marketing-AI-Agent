import { useState } from 'react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, StatusBadge, toUiStatus, Unset } from '../components/ui/primitives'
import { AsyncBoundary, EmptyState, LoadingState } from '../components/ui/states'
import { RadarSweep } from '../components/motion/Signatures'
import { DataTable } from '../components/ui/DataTable'
import type { ProspectSearch } from '../lib/types'

// Prospect Discovery (#977).
//
// Discovery runs against the real NXT Sales company base. The radar is
// atmosphere; the numbers under it are the run's own counts.

interface SearchDetail extends ProspectSearch {
  prospects?: Array<{ crmCompanyId: string; companyName: string | null; score?: number; reasons?: string[] }>
}

export function ProspectDiscovery() {
  const engine = useEngine('prospect')
  const [selected, setSelected] = useState<string | null>(null)

  const searches = useAsync<{ searches: ProspectSearch[] }>((signal) => api.get('/prospects/searches', { signal }), [])
  const detail = useAsync<SearchDetail | null>(
    (signal) => (selected ? api.get(`/prospects/searches/${selected}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [selected],
    { enabled: Boolean(selected) },
  )
  const matched = useAsync<{ prospects: Array<{ crmCompanyId: string; companyName: string | null; fitScore?: number; industry?: string | null }> }>(
    (signal) => api.get(`/prospects/searches/${selected}/prospects`, { signal }),
    [selected],
    { enabled: Boolean(selected) },
  )

  const running = searches.data?.searches.some((s) => toUiStatus(s.status) === 'running') ?? false

  return (
    <EnginePage
      engineId="prospect"
      state={running ? 'running' : searches.data?.searches.length ? 'success' : 'idle'}
      signature={<RadarSweep accent={engine.accent} />}
    >
      <EngineSplit
        main={
          <>
            <Panel title="Discovery" subtitle="Objectives run against the NXT Sales company base">
              <div className="viz">
                <RadarSweep accent={engine.accent} label="Prospect discovery radar" />
                <div className="viz__overlay">
                  <div className="viz__corner">
                    <Metric
                      label="Searches"
                      value={searches.data?.searches.length ?? '—'}
                      size="sm"
                    />
                    <Metric
                      label="Matched"
                      value={searches.data?.searches.reduce((n, s) => n + (s.totalMatched ?? 0), 0) ?? '—'}
                      size="sm"
                    />
                  </div>
                  <div className="viz__corner">
                    <span />
                    <Metric
                      label="Returned"
                      value={searches.data?.searches.reduce((n, s) => n + (s.totalReturned ?? 0), 0) ?? '—'}
                      size="sm"
                    />
                  </div>
                </div>
              </div>
            </Panel>

            <Panel title="Searches" subtitle="Select one to see what it matched" padded={false}>
              <AsyncBoundary
                state={searches}
                what="Reading discovery runs"
                isEmpty={(d) => d.searches.length === 0}
                empty={
                  <EmptyState
                    title="No discovery run yet"
                    detail="A search is started through the orchestrator. Once one has run, its objective and matches appear here."
                  />
                }
              >
                {(d) => (
                  <DataTable
                    rows={d.searches}
                    rowKey={(r) => r.id}
                    selectedKey={selected ?? undefined}
                    onRowClick={(r) => setSelected(r.id)}
                    columns={[
                      { key: 'objective', header: 'Objective', render: (r) => <span className="cell-strong">{r.objective}</span> },
                      { key: 'status', header: 'Status', render: (r) => <StatusBadge status={toUiStatus(r.status)} label={r.status} size="sm" /> },
                      { key: 'matched', header: 'Matched', numeric: true, render: (r) => r.totalMatched },
                      { key: 'returned', header: 'Returned', numeric: true, render: (r) => r.totalReturned },
                      {
                        key: 'approval',
                        header: 'Mapping',
                        render: (r) =>
                          r.requiresApproval ? <Chip tone="warn">Needs approval</Chip> : <Chip>{r.mappingStatus ?? '—'}</Chip>,
                      },
                      { key: 'when', header: 'Started', render: (r) => <span className="mono cell-dim">{new Date(r.createdAt).toLocaleDateString()}</span> },
                    ]}
                  />
                )}
              </AsyncBoundary>
            </Panel>

            {selected && (
              <Panel title="Matched companies" padded={false}>
                {matched.loading ? (
                  <LoadingState what="Reading matched companies" rows={4} />
                ) : matched.data?.prospects?.length ? (
                  <DataTable
                    rows={matched.data.prospects}
                    rowKey={(r) => r.crmCompanyId}
                    columns={[
                      { key: 'name', header: 'Company', render: (r) => r.companyName ?? r.crmCompanyId },
                      { key: 'industry', header: 'Industry', render: (r) => r.industry ?? <Unset what="—" /> },
                      { key: 'fit', header: 'Fit', numeric: true, render: (r) => (r.fitScore != null ? r.fitScore : '—') },
                    ]}
                  />
                ) : (
                  <EmptyState title="No companies returned" detail="This search matched nothing in the CRM." />
                )}
              </Panel>
            )}
          </>
        }
        side={
          <Panel title="Run detail">
            {!selected ? (
              <Unset what="Select a search" />
            ) : detail.loading ? (
              <LoadingState what="Reading the run" rows={3} />
            ) : detail.data ? (
              <>
                <MetricRow>
                  <Metric label="Matched" value={detail.data.totalMatched} size="sm" />
                  <Metric label="Returned" value={detail.data.totalReturned} size="sm" />
                </MetricRow>
                <p className="note" style={{ marginTop: 'var(--s4)' }}>{detail.data.objective}</p>
                {detail.data.requiresApproval && (
                  <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>
                    This run mapped an objective onto CRM values that need a human to confirm before the matches are trusted.
                  </p>
                )}
              </>
            ) : (
              <Unset />
            )}
          </Panel>
        }
      />
    </EnginePage>
  )
}
