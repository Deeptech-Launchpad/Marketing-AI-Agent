import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ExternalLink, Link2Off } from 'lucide-react'
import { getToken } from '../../lib/api'
import type { PdpAssessment, PdpEnrichment, PdpAttributeSource } from '../../lib/types'
import { Chip, Panel } from '../ui/primitives'
import { ErrorState, LoadingState } from '../ui/states'
import './pdpAudit.css'

// THE END PDP AUDIT, ON SCREEN.
//
// Three pieces, shared by Website Audit, Audit Report and AI Workbench so the
// three screens say the same thing about the same run:
//
//   PdpAssessmentPanel   which case the End PDP link is in, and what to do next
//   EnrichedPdpFrame     the enriched product page — the Workbench "After" —
//                        rendered from the SAME HTML the report photographs
//   EnrichmentSummary    the enriched record, with where every value came from

const CASE_CHIP = {
  valid_product: { tone: 'ok', label: 'Valid product page', Icon: CheckCircle2 },
  link_problem: { tone: 'warn', label: 'Link needs attention', Icon: AlertTriangle },
  no_link: { tone: 'danger', label: 'No End PDP link', Icon: Link2Off },
} as const

export function PdpAssessmentPanel({ assessment, companyName }: { assessment: PdpAssessment; companyName: string }) {
  const chip = CASE_CHIP[assessment.case]
  const link = assessment.finalUrl ?? assessment.url
  return (
    <Panel
      title="End PDP audit"
      subtitle={`The product page recorded for ${companyName} in NXT Sales`}
      actions={<Chip tone={chip.tone}>{chip.label}</Chip>}
      className={`pdpa pdpa--${assessment.case}`}
    >
      <div className="pdpa__head">
        <chip.Icon size={20} aria-hidden="true" className="pdpa__icon" />
        <div>
          <p className="pdpa__headline">{assessment.headline}</p>
          <p className="pdpa__explain">{assessment.explanation}</p>
        </div>
      </div>

      <dl className="pdpa__facts">
        <div>
          <dt>End PDP in NXT Sales</dt>
          <dd className="mono">{assessment.endPdpValue?.trim() ? assessment.endPdpValue : 'Empty'}</dd>
        </div>
        {link && (
          <div>
            <dt>Page checked</dt>
            <dd>
              <a href={link} target="_blank" rel="noreferrer noopener" className="pdpa__link">
                {link.length > 90 ? `${link.slice(0, 90)}…` : link} <ExternalLink size={12} aria-hidden="true" />
              </a>
            </dd>
          </div>
        )}
        {assessment.httpStatus !== null && (
          <div>
            <dt>Response</dt>
            <dd className="mono">HTTP {assessment.httpStatus}</dd>
          </div>
        )}
        {assessment.productName && (
          <div>
            <dt>Product</dt>
            <dd>{assessment.productName}</dd>
          </div>
        )}
      </dl>

      {assessment.recommendations.length > 0 && (
        <div className="pdpa__next">
          <p className="eyebrow">What to do next</p>
          <ol>
            {assessment.recommendations.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
        </div>
      )}

      {assessment.suggestedProductUrls.length > 0 && (
        <div className="pdpa__next">
          <p className="eyebrow">Product pages this page links to</p>
          <ul className="pdpa__suggest">
            {assessment.suggestedProductUrls.map((u) => (
              <li key={u}>
                <a href={u} target="_blank" rel="noreferrer noopener">
                  {u}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  )
}

/**
 * The enriched product page, framed.
 *
 * The HTML is fetched with the session token and handed to a sandboxed frame
 * without script permission: the page is static, and nothing in it may run.
 */
export function EnrichedPdpFrame({ runId, title }: { runId: string; title: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [height, setHeight] = useState(1600)
  const frame = useRef<HTMLIFrameElement>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError(null)
    fetch(`/api/v1/website-audit/runs/${runId}/pdp/after.html`, {
      headers: { Authorization: `Bearer ${getToken()}` },
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`The enriched page could not be loaded (HTTP ${res.status}).`)
        setHtml(await res.text())
      })
      .catch((err: unknown) => {
        if ((err as Error)?.name !== 'AbortError') setError(err instanceof Error ? err : new Error(String(err)))
      })
    return () => controller.abort()
  }, [runId, attempt])

  if (error) {
    return (
      <ErrorState
        error={error}
        what="The enriched product page could not be displayed"
        affects="Only the After view. The enriched record itself is unaffected."
        onRetry={() => setAttempt((n) => n + 1)}
      />
    )
  }
  if (html === null) return <LoadingState what="Loading the enriched product page" rows={4} />

  return (
    <iframe
      ref={frame}
      className="pdpframe"
      title={title}
      srcDoc={html}
      // No allow-scripts: the page is static. allow-same-origin lets the frame
      // be measured so it is shown at full height instead of scrolling inside.
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      style={{ height }}
      onLoad={() => {
        const doc = frame.current?.contentDocument
        const measure = () => {
          const h = doc?.documentElement?.scrollHeight
          if (h) setHeight(h + 8)
        }
        measure()
        // Product images arrive after the document loads.
        doc?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure, { once: true }))
      }}
    />
  )
}

const SOURCE_LABEL: Record<PdpAttributeSource, { label: string; tone: 'ok' | 'info' | 'accent' }> = {
  page: { label: 'From their page', tone: 'ok' },
  manufacturer: { label: 'Manufacturer', tone: 'info' },
  enriched: { label: 'AI-enriched', tone: 'accent' },
}

export function EnrichmentSummary({ enrichment }: { enrichment: PdpEnrichment }) {
  const e = enrichment.enriched
  if (!e) {
    return (
      <Panel title="Enriched product record">
        <p className="note">{enrichment.reason ?? 'No enriched record was produced for this run.'}</p>
      </Panel>
    )
  }
  const count = (s: PdpAttributeSource) => e.attributes.filter((a) => a.source === s).length
  const readSources = enrichment.research.sources.filter((s) => s.read)

  return (
    <Panel
      title="Enriched product record"
      subtitle={`${e.attributes.length} attributes · ${e.categoryPath.join(' › ')}`}
      className="pdpsum"
    >
      <p className="pdpsum__title">{e.enrichedTitle}</p>
      <p className="pdpsum__transform">
        <span className="eyebrow">Key transformation</span> {e.keyTransformation}
      </p>

      <div className="pdpsum__counts">
        <Chip tone="ok">{count('page')} from their page</Chip>
        <Chip tone="info">{count('manufacturer')} from manufacturer pages</Chip>
        <Chip tone="accent">{count('enriched')} AI-enriched</Chip>
      </div>
      <p className="note">
        AI-enriched values show what a complete record for this product looks like. They are marked on the enriched
        page and in the report, and must be confirmed against manufacturer data before the customer publishes them.
        Price and availability are only ever the customer&rsquo;s own.
      </p>

      <details className="pdpsum__attrs">
        <summary>Every attribute and where it came from</summary>
        <table>
          <thead>
            <tr>
              <th>Attribute</th>
              <th>Value</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {e.attributes.map((a) => (
              <tr key={a.name}>
                <td>{a.name}</td>
                <td>{a.value}</td>
                <td>
                  <Chip tone={SOURCE_LABEL[a.source].tone}>{SOURCE_LABEL[a.source].label}</Chip>
                  {a.sourceUrl && (
                    <a className="pdpsum__src" href={a.sourceUrl} target="_blank" rel="noreferrer noopener" title={a.sourceUrl}>
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <div className="pdpsum__cols">
        <div>
          <p className="eyebrow">Documents</p>
          <ul>
            {e.documents.map((d) => (
              <li key={`${d.title}${d.url ?? ''}`}>
                {d.url ? (
                  <a href={d.url} target="_blank" rel="noreferrer noopener">
                    {d.title}
                  </a>
                ) : (
                  <>
                    {d.title} <span className="pdpsum__muted">— to be sourced</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow">Manufacturer research</p>
          {readSources.length ? (
            <ul>
              {readSources.map((s) => (
                <li key={s.ref}>
                  <a href={s.url} target="_blank" rel="noreferrer noopener">
                    {s.title ?? s.url}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pdpsum__muted">
              {enrichment.research.note ??
                (enrichment.research.attempted
                  ? 'No manufacturer page about this product was found.'
                  : 'Manufacturer research did not run.')}
            </p>
          )}
        </div>
      </div>
    </Panel>
  )
}
