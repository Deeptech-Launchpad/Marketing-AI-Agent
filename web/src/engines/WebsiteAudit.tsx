import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, Chip, Button, StatusBadge, toUiStatus, Unset, Field } from '../components/ui/primitives'
import { EmptyState, ErrorState, LoadingState } from '../components/ui/states'
import { ScanBeam } from '../components/motion/Signatures'
import { DataTable } from '../components/ui/DataTable'
import type { AuditRun } from '../lib/types'
import { Play } from 'lucide-react'

// Website Audit (#979, crawl half).
//
// A run is addressed by id. The backend has no endpoint that lists historical
// runs, so this workspace works from the run it started or one named in the
// URL rather than inventing a listing the API cannot serve.

const RECENT_KEY = 'altiusnxt.marketing.recentAuditRun'

interface AuditPage {
  id: string
  url: string
  pageType: string
  httpStatus: number | null
  fetchOutcome: string
  title: string | null
}

export function WebsiteAudit() {
  const engine = useEngine('audit')
  const { company } = useCompany()
  const { can } = useAuth()
  const [params, setParams] = useSearchParams()
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<Error | null>(null)

  const runId = params.get('run') ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_KEY) : null)

  const run = useAsync<AuditRun | null>(
    (signal) => (runId ? api.get(`/website-audit/runs/${runId}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [runId],
    { enabled: Boolean(runId) },
  )
  const pages = useAsync<{ pages: AuditPage[] }>(
    (signal) => api.get(`/website-audit/runs/${runId}/pages`, { signal }),
    [runId],
    { enabled: Boolean(runId) },
  )

  const status = toUiStatus(run.data?.status)
  const isRunning = status === 'running'

  // A running crawl refreshes itself, so the counters move as it works.
  useEffect(() => {
    if (!isRunning) return
    const timer = setInterval(() => {
      run.refresh()
      pages.refresh()
    }, 4000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning])

  const start = async () => {
    if (!company) return
    setStarting(true)
    setStartError(null)
    try {
      const res = await api.post<{ auditRunId?: string; runId?: string; id?: string }>('/website-audit/start', {
        crmCompanyId: company.crmCompanyId,
      })
      const created = res.auditRunId ?? res.runId ?? res.id
      if (created) {
        localStorage.setItem(RECENT_KEY, created)
        setParams({ run: created })
      }
    } catch (err) {
      setStartError(err as Error)
    } finally {
      setStarting(false)
    }
  }

  const startAction = can('operate') && company && (
    <Button icon={Play} variant="primary" onClick={start} busy={starting}>
      Start audit
    </Button>
  )

  return (
    <EnginePage
      engineId="audit"
      state={isRunning ? 'running' : run.data ? 'success' : 'idle'}
      signature={<ScanBeam accent={engine.accent} />}
      actions={startAction}
    >
      {startError && <ErrorState error={startError} what="The audit could not be started" onRetry={start} />}

      {!runId ? (
        <EmptyState
          title="No audit run open"
          detail={
            company
              ? `Start an audit for ${company.companyName ?? 'this company'}, or open one directly with ?run=<id>. The platform has no endpoint that lists past runs, so this workspace does not pretend to have one.`
              : 'Select a company, then start an audit.'
          }
          action={startAction || undefined}
        />
      ) : run.loading && !run.data ? (
        <LoadingState what="Crawling the site" visual={<ScanBeam accent={engine.accent} />} />
      ) : !run.data ? (
        <EmptyState title="That run was not found" detail={`No audit run exists with id ${runId}.`} />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel
                title={run.data.companyName ?? 'Audit'}
                subtitle={run.data.startUrl ?? undefined}
                actions={<StatusBadge status={status} label={run.data.status} />}
              >
                <div className="viz">
                  <ScanBeam accent={engine.accent} label="Crawl in progress" />
                  <div className="viz__overlay">
                    <div className="viz__corner">
                      <Metric label="Pages inspected" value={run.data.pagesFetched} size="sm" accent />
                      <Metric label="Product pages" value={run.data.productPages} size="sm" />
                    </div>
                    <div className="viz__corner">
                      <Metric label="Category pages" value={run.data.categoryPages} size="sm" />
                      <Metric label="Unreachable" value={run.data.unreachablePages} size="sm" />
                    </div>
                  </div>
                </div>
              </Panel>

              <Panel title="Inspected pages" subtitle="Every page the crawler actually fetched" padded={false}>
                {pages.loading && !pages.data ? (
                  <LoadingState what="Reading inspected pages" rows={4} />
                ) : pages.data?.pages?.length ? (
                  <DataTable
                    rows={pages.data.pages.slice(0, 60)}
                    rowKey={(r) => r.id}
                    columns={[
                      {
                        key: 'url',
                        header: 'URL',
                        render: (r) => (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="cell-link">
                            {r.url.replace(/^https?:\/\/[^/]+/, '') || '/'}
                          </a>
                        ),
                      },
                      { key: 'type', header: 'Type', render: (r) => <Chip tone={r.pageType === 'product' ? 'accent' : 'neutral'}>{r.pageType}</Chip> },
                      { key: 'status', header: 'HTTP', numeric: true, render: (r) => r.httpStatus ?? '—' },
                      {
                        key: 'outcome',
                        header: 'Outcome',
                        render: (r) => <StatusBadge status={toUiStatus(r.fetchOutcome)} label={r.fetchOutcome.replace(/_/g, ' ')} size="sm" />,
                      },
                    ]}
                  />
                ) : (
                  <EmptyState title="No page recorded yet" detail="The crawl has not stored a page for this run." />
                )}
              </Panel>
            </>
          }
          side={
            <>
              <Panel title="Run">
                <Field label="Status" value={run.data.status} />
                <Field label="Host" value={run.data.rootHost ?? <Unset />} />
                <Field label="Pages fetched" value={run.data.pagesFetched} />
                <Field label="Product pages" value={run.data.productPages} />
                <Field label="HTTP errors" value={run.data.httpErrors} />
                <Field label="Unreachable" value={run.data.unreachablePages} />
                <Field label="Started" value={new Date(run.data.createdAt).toLocaleString()} />
                <Field label="Run id" value={run.data.id} mono />
              </Panel>

              <Panel title="Scope">
                <p className="note">
                  Every figure here describes the pages that were inspected, not the whole catalogue. The crawler stops at
                  a configured page limit, and a site it cannot reach is recorded as unreachable rather than as empty.
                </p>
                {run.data.unreachablePages > 0 && (
                  <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>
                    {run.data.unreachablePages} page(s) could not be fetched. Those pages are excluded from every count
                    rather than assumed to be fine.
                  </p>
                )}
              </Panel>
            </>
          }
        />
      )}
    </EnginePage>
  )
}
