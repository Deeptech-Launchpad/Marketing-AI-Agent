import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, StatusBadge, toUiStatus, Unset, Field } from '../components/ui/primitives'
import { AsyncBoundary, EmptyState, LoadingState } from '../components/ui/states'
import { LayerReveal } from '../components/motion/Signatures'
import { EvidenceList } from '../components/ui/Evidence'
import { DataTable } from '../components/ui/DataTable'
import type { EnrichmentList, EnrichmentRow } from '../lib/types'

// Company Enrichment (#977).
//
// Technologies are only ever shown with the evidence that detected them —
// a header, a script tag, a fragment of markup. A detection with no evidence
// would be a guess, and this engine does not make guesses.

interface TechEvidence {
  what?: string
  where?: string
  fragment?: string
  sourceUrl?: string
}

interface EnrichmentDetail extends Omit<EnrichmentRow, 'technologies'> {
  technologies?: Array<{
    name: string
    category: string
    /** Absent on detections recorded without a confidence grade. */
    confidence?: string
    /**
     * Either a structured chain, or the single markup fragment the detector
     * matched on — whichever form the detector produced is what is stored.
     */
    evidence?: string | TechEvidence[] | null
  }>
}

/**
 * Normalises a detection's evidence into the chain this page renders.
 *
 * A raw fragment is evidence just as much as a structured entry is, so it is
 * carried through as one rather than dropped for arriving in another shape.
 */
function evidenceChain(evidence: string | TechEvidence[] | null | undefined): TechEvidence[] {
  if (!evidence) return []
  if (Array.isArray(evidence)) return evidence
  const fragment = String(evidence).trim()
  return fragment ? [{ fragment }] : []
}

export function Enrichment() {
  const engine = useEngine('enrichment')
  const { company } = useCompany()
  const id = company?.crmCompanyId

  const list = useAsync<EnrichmentList>((signal) => api.get('/enrichment', { signal }), [])
  const detail = useAsync<EnrichmentDetail | null>(
    (signal) => (id ? api.get(`/enrichment/companies/${id}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )

  // Normalised once, so everything below reads a single evidence shape.
  const technologies = (detail.data?.technologies ?? []).map((t) => ({
    ...t,
    evidence: evidenceChain(t.evidence),
  }))
  const byCategory = technologies.reduce<Record<string, typeof technologies>>((acc, t) => {
    ;(acc[t.category] ??= []).push(t)
    return acc
  }, {})

  return (
    <EnginePage
      engineId="enrichment"
      state={detail.data ? 'success' : 'idle'}
      signature={<LayerReveal accent={engine.accent} layers={3} />}
    >
      <EngineSplit
        main={
          !company ? (
            <EmptyState title="Select a company" detail="Enrichment results are shown per company." />
          ) : detail.loading ? (
            <LoadingState what="Reading the detected technology stack" visual={<LayerReveal accent={engine.accent} />} />
          ) : !detail.data ? (
            <EmptyState
              title="Not enriched yet"
              detail={`${company.companyName ?? 'This company'} has no enrichment record. Enrichment inspects the public site and records only what it can point at.`}
            />
          ) : (
            <>
              <Panel
                title="Detected technology"
                subtitle={`${detail.data.technologyCount} detected · ${detail.data.status}`}
                actions={<StatusBadge status={toUiStatus(detail.data.status)} label={detail.data.status} size="sm" />}
              >
                {technologies.length === 0 ? (
                  <EmptyState
                    title="Nothing detected"
                    detail={
                      detail.data.failureReason ??
                      'The crawl completed but found no technology it could evidence. An undetected stack is reported as undetected rather than filled in.'
                    }
                  />
                ) : (
                  <div className="layers">
                    {Object.entries(byCategory).map(([category, items], ci) => (
                      <section key={category} className="layers__row node-reveal" style={{ ['--i' as string]: ci }}>
                        <span className="layers__cat">{category}</span>
                        <div className="layers__items">
                          {items.map((t) => (
                            <div key={t.name} className="layers__tech" style={{ ['--e' as string]: engine.accent }}>
                              <div className="layers__techhead">
                                <span className="layers__techname">{t.name}</span>
                                {t.confidence ? (
                                  <Chip tone={t.confidence === 'high' ? 'ok' : t.confidence === 'medium' ? 'warn' : 'neutral'}>
                                    {t.confidence}
                                  </Chip>
                                ) : (
                                  <Unset what="Confidence not graded" />
                                )}
                              </div>
                              {/* The evidence chain, as the reference lays it out. */}
                              {t.evidence.length ? (
                                <ul className="layers__ev">
                                  {t.evidence.slice(0, 3).map((e, i) => (
                                    <li key={i}>{e.what ?? e.fragment ?? e.where}</li>
                                  ))}
                                </ul>
                              ) : (
                                <p className="layers__noev">No evidence fragment stored.</p>
                              )}
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </Panel>

              {technologies.some((t) => t.evidence.length > 0) && (
                <Panel title="Evidence chain" subtitle="What each detection was based on">
                  <EvidenceList
                    items={technologies.flatMap((t) =>
                      t.evidence.map((e) => ({
                        what: `${t.name} — ${e.what ?? 'detected'}`,
                        field: t.category,
                        source: e.where,
                        sourceUrl: e.sourceUrl,
                        fragment: e.fragment,
                      })),
                    )}
                  />
                </Panel>
              )}
            </>
          )
        }
        side={
          <>
            {detail.data && (
              <Panel title="This run">
                <Field label="Status" value={detail.data.status} />
                <Field label="Technologies" value={detail.data.technologyCount} />
                <Field
                  label="Source"
                  value={
                    detail.data.sourceUrl ? (
                      <a href={detail.data.sourceUrl} target="_blank" rel="noopener noreferrer">
                        {detail.data.sourceUrl.replace(/^https?:\/\//, '')}
                      </a>
                    ) : (
                      <Unset />
                    )
                  }
                />
                <Field label="Finished" value={detail.data.finishedAt ? new Date(detail.data.finishedAt).toLocaleString() : <Unset what="Still running" />} />
                {detail.data.failureReason && (
                  <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>{detail.data.failureReason}</p>
                )}
              </Panel>
            )}

            <Panel title="All enrichments" padded={false}>
              <AsyncBoundary
                state={list}
                what="Reading enrichment runs"
                isEmpty={(d) => (d.enrichments?.length ?? 0) === 0}
                empty={<EmptyState title="No enrichment yet" />}
              >
                {(d) => (
                  <>
                    <div style={{ padding: 'var(--s4)' }}>
                      <MetricRow>
                        <Metric label="Companies" value={d.enrichments.length} size="sm" />
                        <Metric
                          label="Succeeded"
                          value={d.enrichments.filter((e) => e.status === 'succeeded' || e.status === 'completed').length}
                          size="sm"
                        />
                      </MetricRow>
                    </div>
                    <DataTable
                      rows={d.enrichments.slice(0, 40)}
                      rowKey={(r) => r.id}
                      selectedKey={d.enrichments.find((e) => e.crmCompanyId === id)?.id}
                      columns={[
                        { key: 'name', header: 'Company', render: (r) => r.companyName ?? r.crmCompanyId },
                        { key: 'tech', header: 'Tech', numeric: true, render: (r) => r.technologyCount },
                      ]}
                    />
                  </>
                )}
              </AsyncBoundary>
            </Panel>
          </>
        }
      />
    </EnginePage>
  )
}
