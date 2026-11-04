import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync, usePolling } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Button, Metric, MetricRow, Panel } from '../components/ui/primitives'
import { ErrorState, LoadingState } from '../components/ui/states'
import { CompanyList } from './warmleads/CompanyList'
import { ControlsPanel } from './warmleads/ControlsPanel'
import { PilotPanel } from './warmleads/PilotPanel'
import { UsagePanel } from './warmleads/UsagePanel'
import { num } from './warmleads/labels'
import type { Overview } from './warmleads/types'
import './settings.css'

// WARM LEADS (permanent module, 2026-11-04).
//
// Every NXT Sales company is evaluated as warm, early signal, cold or not enough data: first a cheap screen
// (the CRM record and the company website), then Gemini web research only for companies that look promising.
// A pilot of 100 companies is reviewed and approved first; after that a few companies are processed each night.
// The work is done by a separate worker, inside a processing window, within daily limits that are counted in the
// database. This page only reads results and changes settings. It never sends an email, never contacts a company,
// and writes nothing to NXT Sales unless sending was separately approved.

export function WarmLeads() {
  const navigate = useNavigate()
  const { can } = useAuth()
  const admin = can('admin')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const ov = useAsync<Overview>((signal) => api.get('/warm-leads/overview', { signal }), [])

  // Poll while something is happening, so counts move without a reload.
  const working = ov.data ? !ov.data.settings.paused && ov.data.server.workerEnabled : false
  const waiting = ov.data?.listRefresh.state === 'requested' || ov.data?.listRefresh.state === 'running' || ov.data?.stage === 'pilot_preparing'
  usePolling(
    () => {
      ov.refresh()
      setRefreshKey((k) => k + 1)
    },
    working || Boolean(waiting),
    6000,
  )

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
      ov.refresh()
      setRefreshKey((k) => k + 1)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (ov.loading && !ov.data) return <LoadingState what="Reading the warm-lead evaluations" />
  if (ov.error && !ov.data) return <ErrorState error={ov.error} what="The warm-lead evaluations could not be read" onRetry={ov.refresh} />
  const o = ov.data!
  const c = o.counts
  const attention = c.failed + c.needsReevaluation

  return (
    <div className="set">
      <header className="set__head">
        <Button icon={ArrowLeft} variant="quiet" onClick={() => navigate('/settings')}>Settings</Button>
        <h1 className="set__title">Warm leads</h1>
        <p className="set__sub">
          Which NXT Sales companies show current interest. A cheap screen of the CRM record and website comes first; web research (Gemini) is used only for promising
          companies. Results stay in this application unless sending to NXT Sales is approved. No email is sent and no company is contacted.
        </p>
      </header>

      {error && (
        <p className="note note--caveat" role="alert">
          {error}
        </p>
      )}
      {ov.error && ov.data && (
        <p className="note note--caveat" role="alert">
          The screen could not be refreshed ({ov.error.message}). What is shown may be out of date; the status below is not live.
        </p>
      )}
      {!o.server.workerEnabled && (
        <p className="note note--caveat">
          The Warm Leads worker is switched off on this server (WARM_LEADS_WORKER_ENABLED). You can prepare everything here, but nothing is evaluated until it is switched on.
        </p>
      )}

      {o.server.workerEnabled && o.server.geminiKeyProblem && (
        <p className="note note--caveat" role="alert">
          Warm Leads is idle: {o.server.geminiKeyProblem}
        </p>
      )}

      <Panel
        title="Progress"
        subtitle={`${num(c.total)} companies in NXT Sales`}
        actions={<Button size="sm" icon={RefreshCw} onClick={() => { ov.refresh(); setRefreshKey((k) => k + 1) }}>Refresh</Button>}
      >
        <MetricRow>
          <Metric label="Evaluated" value={num(c.evaluated)} hint="completed" />
          <Metric label="Pending" value={num(c.pending)} hint="not yet evaluated" />
          <Metric label="Warm" value={num(c.warm)} accent />
          <Metric label="Early signal" value={num(c.earlySignal)} hint="needs review" />
          <Metric label="Cold" value={num(c.cold)} />
          <Metric label="Not enough data" value={num(c.insufficientData)} />
          <Metric label="Research incomplete" value={num(c.researchIncomplete)} hint="never counted as Cold" />
          <Metric label="Failed" value={num(c.failed)} hint="retried a few times, then by Retry failed" />
          <Metric label="Re-check due" value={num(c.needsReevaluation)} hint="keeps its result" />
          <Metric label="In progress" value={num(c.inProgress)} />
        </MetricRow>
        <p className="note" style={{ marginTop: 'var(--s3)' }}>
          Existing customers {num(c.existingCustomer)} · active opportunities {num(c.activeOpportunity)} · do not contact {num(c.doNotContact)}
          {c.notInCrm ? ` · ${num(c.notInCrm)} no longer in NXT Sales` : ''}
          {attention ? ` · ${num(attention)} failed or due for a re-check` : ''}
        </p>
      </Panel>

      <PilotPanel o={o} admin={admin} act={act} busy={busy} refreshKey={refreshKey} />
      <ControlsPanel o={o} admin={admin} act={act} busy={busy} />
      <UsagePanel o={o} />
      <CompanyList refreshKey={refreshKey} />
    </div>
  )
}
