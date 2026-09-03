import { useSearchParams } from 'react-router-dom'
import { api, getToken } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, Button, Unset, Field } from '../components/ui/primitives'
import { EmptyState, LoadingState } from '../components/ui/states'
import { EvidenceButton } from '../components/ui/Evidence'
import type { AuditRun, CatalogFinding } from '../lib/types'
import { Download } from 'lucide-react'

// Audit Report (#979, findings half).
//
// Findings are shown exactly as the backend wrote them — sample-scoped
// sentences with their denominator in the text. No percentage is derived here,
// because the engine deliberately never produced one.

const RECENT_KEY = 'altiusnxt.marketing.recentAuditRun'

const PRIORITY_TONE = { high: 'danger', medium: 'warn', low: 'neutral' } as const

export function AuditReport() {
  const engine = useEngine('report')
  const [params] = useSearchParams()
  const runId = params.get('run') ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_KEY) : null)

  const run = useAsync<AuditRun | null>(
    (signal) => (runId ? api.get(`/website-audit/runs/${runId}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [runId],
    { enabled: Boolean(runId) },
  )
  const findings = useAsync<{ findings: CatalogFinding[] }>(
    (signal) => api.get(`/website-audit/runs/${runId}/findings`, { signal }),
    [runId],
    { enabled: Boolean(runId) },
  )
  const collateral = useAsync<{ collateral?: { headline?: string; scopeNote?: string; sections?: Array<{ title: string; body: string }> } }>(
    (signal) => api.get(`/website-audit/runs/${runId}/collateral`, { signal, nullOn404: true }),
    [runId],
    { enabled: Boolean(runId) },
  )

  const rows = findings.data?.findings ?? []
  const byPriority = {
    high: rows.filter((f) => f.priority === 'high').length,
    medium: rows.filter((f) => f.priority === 'medium').length,
    low: rows.filter((f) => f.priority === 'low').length,
  }

  const downloadPdf = () => {
    // The PDF endpoint is authenticated, so it is fetched with the session
    // token rather than opened as a bare link.
    const token = getToken()
    fetch(`/api/v1/website-audit/runs/${runId}/report.pdf`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('The report could not be downloaded.'))))
      .then((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `audit-report-${runId}.pdf`
        a.click()
        URL.revokeObjectURL(url)
      })
      .catch(() => undefined)
  }

  return (
    <EnginePage
      engineId="report"
      state={rows.length ? 'success' : 'idle'}
      actions={
        runId && rows.length > 0 && (
          <Button icon={Download} onClick={downloadPdf}>
            Export PDF
          </Button>
        )
      }
    >
      {!runId ? (
        <EmptyState title="No audit run open" detail="Open an audit in the Website Audit workspace first; its report is built from that run." />
      ) : findings.loading && !findings.data ? (
        <LoadingState what="Assembling findings from stored observations" rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No findings for this run"
          detail="The audit completed without producing a finding, or has not reached the analysis stage. A run with no reachable product page legitimately produces none."
        />
      ) : (
        <EngineSplit
          main={
            <>
              {collateral.data?.collateral?.headline && (
                <Panel title="Report">
                  <p className="report__headline">{collateral.data.collateral.headline}</p>
                  {collateral.data.collateral.scopeNote && (
                    <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>
                      {collateral.data.collateral.scopeNote}
                    </p>
                  )}
                </Panel>
              )}

              <Panel title="Findings" subtitle={`${rows.length} finding(s), highest priority first`}>
                <ol className="findings">
                  {rows.map((f, i) => (
                    <li
                      key={f.id}
                      className="findings__item node-reveal"
                      style={{ ['--i' as string]: i, ['--e' as string]: engine.accent }}
                    >
                      <header className="findings__head">
                        <span className="findings__num mono">{String(i + 1).padStart(2, '0')}</span>
                        <h3 className="findings__title">{f.title}</h3>
                        <Chip tone={PRIORITY_TONE[f.priority as keyof typeof PRIORITY_TONE] ?? 'neutral'}>
                          {f.priority}
                        </Chip>
                      </header>

                      {/* The metric always names its denominator — never a percentage. */}
                      <p className="findings__metric">{f.metric}</p>
                      <p className="findings__body">{f.finding}</p>
                      <p className="findings__rec">
                        <span className="eyebrow">Recommendation</span> {f.recommendation}
                      </p>

                      <footer className="findings__foot">
                        <span className="findings__scope mono">
                          {f.observedCount} of {f.sampleSize} inspected {f.sampleUnit}
                        </span>
                        <EvidenceButton
                          title={f.title}
                          items={(f.evidence ?? []).map((e) => ({
                            what: f.metric,
                            field: e.field ?? undefined,
                            sourceUrl: e.sourceUrl,
                            source: e.sourceUrl ? new URL(e.sourceUrl).pathname : undefined,
                            fragment: e.fragment,
                            reference: e.observationId,
                            how: 'Recorded by the website audit crawler from the page itself.',
                          }))}
                        />
                      </footer>
                    </li>
                  ))}
                </ol>
              </Panel>
            </>
          }
          side={
            <>
              <Panel title="Priorities">
                <MetricRow>
                  <Metric label="High" value={byPriority.high} size="sm" />
                  <Metric label="Medium" value={byPriority.medium} size="sm" />
                  <Metric label="Low" value={byPriority.low} size="sm" />
                </MetricRow>
              </Panel>

              {run.data && (
                <Panel title="Sample scope">
                  <Field label="Company" value={run.data.companyName ?? <Unset />} />
                  <Field label="Pages inspected" value={run.data.pagesFetched} />
                  <Field label="Product pages" value={run.data.productPages} />
                  <Field label="Run id" value={run.data.id} mono />
                  <p className="note" style={{ marginTop: 'var(--s3)' }}>
                    Every figure in this report describes the pages that were inspected. It is not a measure of the whole
                    catalogue, and the report says so in its own words.
                  </p>
                </Panel>
              )}
            </>
          }
        />
      )}
    </EnginePage>
  )
}
