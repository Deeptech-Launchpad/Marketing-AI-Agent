import { Chip } from '../../components/ui/primitives'
import { CLASS, DEEP, fmt } from './labels'
import type { Evaluation } from './types'

/** One evaluation: classification, score, the reason it was given, and every piece of evidence with its source link. */
export function EvaluationCard({ e, heading }: { e: Evaluation; heading?: string }) {
  const cls = e.classification ? CLASS[e.classification] : null
  const incomplete = e.researchIncomplete
  return (
    <article className="panel" style={{ padding: 'var(--s3)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 'var(--s2)', flexWrap: 'wrap' }}>
        <strong>{heading ?? e.companyName ?? e.crmCompanyId}</strong>
        <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {e.status === 'failed' ? (
            <Chip tone="danger">Failed — will retry</Chip>
          ) : incomplete ? (
            <Chip tone="warn">Research incomplete — not final</Chip>
          ) : e.status === 'done' && cls ? (
            <Chip tone={cls.tone}>{cls.label}</Chip>
          ) : (
            <Chip tone="warn">{e.status}</Chip>
          )}
          {e.score != null && !incomplete && <Chip>Score {e.score}/100</Chip>}
          {e.confidence && !incomplete && <Chip>{e.confidence} confidence</Chip>}
          {e.deepCheck && <Chip>{DEEP[e.deepCheck] ?? e.deepCheck}</Chip>}
        </span>
      </div>
      <p className="note" style={{ margin: '4px 0' }}>
        {e.website ? <a href={/^https?:/i.test(e.website) ? e.website : `https://${e.website}`} target="_blank" rel="noopener noreferrer">{e.website}</a> : 'No website on record'}
      </p>
      {e.summary && <p style={{ margin: '4px 0' }}>{e.summary}</p>}
      {e.error && <p className="note note--caveat" style={{ margin: '4px 0' }}>{e.error}</p>}
      {e.status === 'failed' && (
        <p className="note" style={{ margin: '4px 0' }}>
          Not classified: a company that could not be read is neither cold nor “not enough data”. It is retried automatically.
        </p>
      )}
      {incomplete && (
        <p className="note" style={{ margin: '4px 0' }}>
          The web research could not be finished (the Gemini call limit was reached). This is not a Cold result; the company is checked again.
        </p>
      )}
      {e.reasons && e.reasons.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {e.reasons.map((r, i) => (
            <li key={i}>
              <strong className="tnum">{r.points > 0 ? `+${r.points}` : r.points}</strong> {r.summary}
              {r.evidence && <span className="note"> — {r.evidence}</span>}
              {r.observedAt && <span className="note"> ({r.observedAt})</span>}
              {r.sourceUrl && /^https?:\/\//i.test(r.sourceUrl) && (
                <>
                  {' '}
                  <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer">source</a>
                </>
              )}{' '}
              <span className="note">[{r.source}]</span>
            </li>
          ))}
        </ul>
      )}
      <p className="note" style={{ margin: '6px 0 0' }}>
        Evaluated {fmt(e.evaluatedAt)}
        {e.tier ? ` · ${e.tier === 'deep' ? 'with web research' : 'screened only'}` : ''}
        {e.geminiCalls ? ` · ${e.geminiCalls} Gemini calls` : ''}
        {e.costUsd ? ` · AI cost $${e.costUsd.toFixed(4)}` : ''}
      </p>
    </article>
  )
}
