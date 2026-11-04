import { useEffect, useState } from 'react'
import { CheckCircle2, Play, RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { Button, Metric, MetricRow, Panel } from '../../components/ui/primitives'
import { ErrorState, LoadingState } from '../../components/ui/states'
import { EvaluationCard } from './EvaluationCard'
import { fmt, num } from './labels'
import type { Evaluation, Overview } from './types'

type Act = (name: string, fn: () => Promise<unknown>) => Promise<void>

/** The first stage: a 100-company pilot, reviewed and approved before anything else is processed. */
export function PilotPanel({ o, admin, act, busy, refreshKey }: { o: Overview; admin: boolean; act: Act; busy: string | null; refreshKey: number }) {
  const [confirm, setConfirm] = useState(false)
  const p = o.pilot
  const size = o.settings.pilotSize

  // The refresh counter must NOT be part of the key: a changed key blanks the cards every few seconds. A refresh keeps them on screen.
  const results = useAsync<{ evaluations: Evaluation[] }>((signal) => api.get('/warm-leads/pilot/results', { signal }), [o.stage], {
    enabled: o.stage === 'pilot_review' || o.stage === 'pilot_running',
  })
  useEffect(() => {
    if (refreshKey > 0) results.refresh()
  }, [refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  if (o.stage === 'daily') {
    return (
      <Panel title="Pilot" subtitle={`${size}-company pilot`}>
        <p className="note">
          <CheckCircle2 size={14} /> Approved {fmt(p.approvedAt)}{p.approvedBy ? ` by ${p.approvedBy}` : ''}. Daily processing is now allowed, but it stays paused until you press Start under Controls.
        </p>
      </Panel>
    )
  }

  return (
    <Panel
      title={`Step 1 — ${size}-company pilot`}
      subtitle={`A fixed-seed representative sample of ${size} companies from the real NXT Sales data: several countries and industries, with and without a website, recent replies, open deals and existing customers. Results stay in this application only — nothing is written to NXT Sales and no email is sent.`}
    >
      {o.stage === 'no_company_list' && (
        <>
          <p className="note">First read the company list from NXT Sales (Controls below). Nothing is evaluated yet.</p>
        </>
      )}

      {o.stage === 'pilot_not_requested' && (
        <>
          <p className="note">The company list is loaded ({num(o.counts.total)} companies). Prepare the pilot, then start processing; it runs inside the processing window.</p>
          {admin && (
            <Button icon={Play} variant="primary" busy={busy === 'pilot'} onClick={() => act('pilot', () => api.post('/warm-leads/pilot', {}))}>
              Prepare the {size}-company pilot
            </Button>
          )}
        </>
      )}

      {o.stage === 'pilot_preparing' && (
        <p className="note">
          The worker is choosing the {size} companies (this reads NXT Sales, read-only, and can take a few minutes). Once they are chosen, press Start in Controls; they are then evaluated inside the processing window.
        </p>
      )}

      {o.stage === 'pilot_failed' && (
        <>
          <p className="note note--caveat">The pilot could not be prepared: {p.run?.failureReason ?? 'unknown reason'}</p>
          {admin && (
            <Button icon={RefreshCw} busy={busy === 'pilot'} onClick={() => act('pilot', () => api.post('/warm-leads/pilot', {}))}>
              Prepare it again
            </Button>
          )}
        </>
      )}

      {(o.stage === 'pilot_running' || o.stage === 'pilot_review') && (
        <>
          <MetricRow>
            <Metric label="Companies" value={`${p.counts.done + p.counts.failed}/${p.counts.total}`} hint="processed" />
            <Metric label="Warm" value={num(p.counts.warm)} accent />
            <Metric label="Early signal" value={num(p.counts.earlySignal)} />
            <Metric label="Cold" value={num(p.counts.cold)} />
            <Metric label="Not enough data" value={num(p.counts.insufficientData)} />
            <Metric label="Research incomplete" value={num(p.counts.incomplete)} hint="not Cold" />
            <Metric label="Failed (retry)" value={num(p.counts.failed)} />
            <Metric label="Waiting" value={num(p.counts.queued + p.counts.running)} />
          </MetricRow>
          {o.today && (
            <p className="note" style={{ marginTop: 'var(--s2)' }}>
              Gemini calls {num(o.today.geminiCalls)} of {num(o.today.geminiCeiling)} (pilot ceiling) · companies {num(o.today.companiesStarted)} of {num(o.today.companyLimit)}
            </p>
          )}
        </>
      )}

      {o.stage === 'pilot_review' && (
        <div style={{ marginTop: 'var(--s4)' }}>
          <h3 style={{ margin: '0 0 var(--s2)' }}>Review the results, then approve</h3>
          <p className="note">Read every result below. Failed companies are retried and do not block approval, but approve only if the results you can read are meaningful. Nothing else is processed until the pilot is approved, and approving does not start daily processing: it stays paused until you press Start.</p>
          {p.counts.total < size && (
            <p className="note note--caveat" role="alert">
              This pilot has {num(p.counts.total)} companies, not {num(size)}. Approve it only if that is what you expect.
            </p>
          )}
          {p.counts.failed + p.counts.incomplete > 0 && (
            <p className="note note--caveat">
              {num(p.counts.failed)} failed and {num(p.counts.incomplete)} incomplete of {num(p.counts.total)}. They stay as they are (never Cold) and are retried later.
            </p>
          )}
          {admin ? (
            <>
              <label className="check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', margin: 'var(--s2) 0' }}>
                <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
                <span>I reviewed the pilot results and the classifications (warm, early signal, cold and the rest) are meaningful.</span>
              </label>
              <Button icon={CheckCircle2} variant="primary" disabled={!confirm || !p.canApprove} busy={busy === 'approve'} onClick={() => act('approve', () => api.post('/warm-leads/pilot/approve', { confirm: true }))}>
                Approve the pilot — allow daily processing
              </Button>
            </>
          ) : (
            <p className="note">An admin approves the pilot.</p>
          )}
        </div>
      )}

      {(o.stage === 'pilot_running' || o.stage === 'pilot_review') && (
        <div style={{ marginTop: 'var(--s4)', display: 'grid', gap: 'var(--s3)' }}>
          {!results.data ? (
            results.error ? <ErrorState error={results.error} what="The pilot results could not be read" onRetry={results.refresh} /> : <LoadingState what="Reading the pilot results" />
          ) : (
            results.data!.evaluations.filter((e) => e.status === 'done' || e.status === 'failed').map((e) => <EvaluationCard key={e.id} e={e} />)
          )}
        </div>
      )}
    </Panel>
  )
}
