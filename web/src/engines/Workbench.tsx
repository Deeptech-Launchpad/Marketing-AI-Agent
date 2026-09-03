import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useAsync, useReducedMotion } from '../lib/hooks'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, Unset, Field } from '../components/ui/primitives'
import { BlockedState, EmptyState, LoadingState } from '../components/ui/states'
import { EvidenceButton } from '../components/ui/Evidence'
import type { WorkbenchDemo } from '../lib/types'
import { ArrowRight } from 'lucide-react'

// AI Workbench (#981).
//
// BEFORE and AFTER, from the prospect's own evidence. The AFTER panel never
// contains a value the audit did not observe: a field that was absent stays
// absent, marked "still not published", because inventing a specification is
// the one thing this engine must never do.

const RECENT_KEY = 'altiusnxt.marketing.recentAuditRun'

const DELTA_TONE = {
  added: 'ok',
  restructured: 'info',
  reworded: 'accent',
  unchanged: 'neutral',
  still_absent: 'warn',
} as const

const DELTA_LABEL: Record<string, string> = {
  added: 'Recovered from the page',
  restructured: 'Made machine-readable',
  reworded: 'Rewritten',
  unchanged: 'Unchanged',
  still_absent: 'Still not published',
}

export function Workbench() {
  const engine = useEngine('workbench')
  const reduced = useReducedMotion()
  const [params] = useSearchParams()
  const runId = params.get('run') ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_KEY) : null)

  const demo = useAsync<WorkbenchDemo | null>(
    (signal) => (runId ? api.get(`/website-audit/runs/${runId}/workbench`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [runId],
    { enabled: Boolean(runId) },
  )

  const fields = demo.data?.fields ?? []
  const improved = fields.filter((f) => f.delta !== 'unchanged' && f.delta !== 'still_absent')
  const absent = fields.filter((f) => f.delta === 'still_absent')

  return (
    <EnginePage engineId="workbench" state={demo.data?.status === 'ready' ? 'success' : 'idle'}>
      {!runId ? (
        <EmptyState title="No audit run open" detail="A demonstration is built from an approved audit. Open a run first." />
      ) : demo.loading && !demo.data ? (
        <LoadingState what="Building the before and after comparison" rows={5} />
      ) : !demo.data ? (
        <EmptyState
          title="No demonstration built"
          detail="A Workbench demonstration is built from an approved audit report. Approve the report for this run first."
        />
      ) : demo.data.status === 'no_product_page' ? (
        <BlockedState
          what="No demonstration could be built"
          why={demo.data.statusReason ?? 'The audit did not record a product page suitable for a comparison.'}
          affects="There is nothing customer-facing to share for this company."
          remediation="Re-run the audit against a site section that publishes product pages."
        />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel
                title={demo.data.productName ?? 'Product page'}
                subtitle={demo.data.productPageUrl ?? undefined}
                actions={
                  <Chip tone={demo.data.builtFromUnapproved ? 'warn' : 'ok'}>
                    {demo.data.builtFromUnapproved ? 'Built from an unapproved report' : 'From an approved report'}
                  </Chip>
                }
              >
                {/* The transformation: two panels, the right one arriving as
                    an upgrade of the left. */}
                <div className="ba">
                  <section className="ba__side ba__side--before">
                    <header className="ba__head">
                      <span className="ba__cap">Before</span>
                      <span className="ba__sub">Published today</span>
                    </header>
                    <dl className="ba__fields">
                      {fields.map((f) => (
                        <div key={`b-${f.field}`} className="ba__field">
                          <dt>{f.label}</dt>
                          <dd className={f.before ? '' : 'is-absent'}>{f.before ?? 'Not published'}</dd>
                        </div>
                      ))}
                    </dl>
                  </section>

                  <span className="ba__arrow" aria-hidden="true">
                    <ArrowRight size={16} />
                  </span>

                  <section className="ba__side ba__side--after" style={{ ['--e' as string]: engine.accent }}>
                    <header className="ba__head">
                      <span className="ba__cap">After</span>
                      <span className="ba__sub">Built from the same evidence</span>
                    </header>
                    <dl className="ba__fields">
                      {fields.map((f, i) => (
                        <div
                          key={`a-${f.field}`}
                          className={`ba__field${reduced ? '' : ' ba__field--lift'}`}
                          style={{ ['--i' as string]: Math.min(i, 14) }}
                        >
                          <dt>
                            {f.label}
                            <Chip tone={DELTA_TONE[f.delta as keyof typeof DELTA_TONE] ?? 'neutral'}>
                              {DELTA_LABEL[f.delta] ?? f.delta}
                            </Chip>
                          </dt>
                          <dd className={f.after ? '' : 'is-absent'}>
                            {f.after ?? 'Still not published'}
                            {(f.sourceFragment || f.sourceUrl) && (
                              <EvidenceButton
                                title={f.label}
                                label="Source"
                                items={[
                                  {
                                    what: f.after ?? 'No value could be produced.',
                                    field: f.field,
                                    sourceUrl: f.sourceUrl,
                                    source: f.sourcePath ?? undefined,
                                    fragment: f.sourceFragment,
                                    how: f.transformRule ?? undefined,
                                  },
                                ]}
                              />
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </section>
                </div>
              </Panel>

              {demo.data.valuePoints && demo.data.valuePoints.length > 0 && (
                <Panel title="Why this matters">
                  <div className="grid-3">
                    {demo.data.valuePoints.map((v, i) => (
                      <div key={v.title} className="value node-reveal" style={{ ['--i' as string]: i }}>
                        <p className="value__title">{v.title}</p>
                        <p className="value__why">{v.why}</p>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </>
          }
          side={
            <>
              <Panel title="Coverage">
                <MetricRow>
                  <Metric label="Published today" value={`${demo.data.observedFieldCount}/${demo.data.totalFieldCount}`} size="sm" />
                  <Metric label="Improved" value={improved.length} accent size="sm" />
                  <Metric label="Still absent" value={absent.length} size="sm" />
                </MetricRow>
                <p className="note" style={{ marginTop: 'var(--s4)' }}>
                  Every value on the right came from this company's own page. A field the audit did not observe is shown
                  as still absent rather than filled in.
                </p>
              </Panel>

              <Panel title="Demonstration">
                <Field label="Status" value={demo.data.status.replace(/_/g, ' ')} />
                <Field label="Company" value={demo.data.companyName ?? <Unset />} />
                <Field label="Built" value={new Date(demo.data.generatedAt).toLocaleString()} />
                <Field label="Source report" value={demo.data.sourceReportStatus ?? <Unset />} />
                {demo.data.builtFromUnapproved && (
                  <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>
                    This demonstration was built with the development bypass enabled. A customer-facing demonstration
                    should come from an approved report.
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
