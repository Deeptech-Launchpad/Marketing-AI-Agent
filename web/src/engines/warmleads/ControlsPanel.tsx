import { useEffect, useState } from 'react'
import { Pause, Play, RefreshCw, RotateCcw, Save, Send } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Panel } from '../../components/ui/primitives'
import { fmt } from './labels'
import type { Overview } from './types'

type Act = (name: string, fn: () => Promise<unknown>) => Promise<void>

/** Start / pause, the daily limits, the processing window, reading the company list, retrying failures, and the NXT Sales switch. */
export function ControlsPanel({ o, admin, act, busy }: { o: Overview; admin: boolean; act: Act; busy: string | null }) {
  const s = o.settings
  const [companies, setCompanies] = useState(String(s.dailyCompanyLimit))
  const [ceiling, setCeiling] = useState(String(s.dailyGeminiCeiling))
  const [retryShare, setRetryShare] = useState(String(s.retryShare))
  const [win, setWin] = useState(s.window)
  const [scaleOk, setScaleOk] = useState(false)

  // Follow the server when it changes (another admin, or a save).
  useEffect(() => {
    setCompanies(String(s.dailyCompanyLimit))
    setCeiling(String(s.dailyGeminiCeiling))
    setRetryShare(String(s.retryShare))
    setWin(s.window)
  }, [s.dailyCompanyLimit, s.dailyGeminiCeiling, s.retryShare, s.window.start, s.window.end, s.window.timezone]) // eslint-disable-line react-hooks/exhaustive-deps

  const state = !o.server.workerEnabled
    ? { label: 'Worker switched off on this server', tone: 'danger' as const }
    : o.server.geminiKeyProblem
      ? { label: 'No Gemini key of its own: idle', tone: 'danger' as const }
    : s.paused
      ? { label: 'Paused', tone: 'neutral' as const }
      : o.windowOpenNow
        ? { label: 'Running', tone: 'ok' as const }
        : { label: `Started — waiting for ${s.window.start}–${s.window.end} ${s.window.timezone}`, tone: 'warn' as const }

  const limitsChanged = companies !== String(s.dailyCompanyLimit) || ceiling !== String(s.dailyGeminiCeiling) || retryShare !== String(s.retryShare)
  const windowChanged = win.start !== s.window.start || win.end !== s.window.end || win.timezone !== s.window.timezone
  // There is exactly one higher level (50 a day). Nothing above it is offered.
  const nextLevel = s.approvedMaxCompanies < 50 ? 50 : null
  const refreshing = o.listRefresh.state === 'requested' || o.listRefresh.state === 'running'

  return (
    <Panel title="Controls" subtitle="Nothing is evaluated unless it is started here, inside the processing window.">
      <div className="row" style={{ gap: 'var(--s3)', alignItems: 'center', flexWrap: 'wrap' }}>
        <Chip tone={state.tone}>{state.label}</Chip>
        {admin &&
          (s.paused ? (
            <Button icon={Play} variant="primary" busy={busy === 'start'} onClick={() => act('start', () => api.post('/warm-leads/start', {}))}>
              Start
            </Button>
          ) : (
            <Button icon={Pause} busy={busy === 'pause'} onClick={() => act('pause', () => api.post('/warm-leads/pause', {}))}>
              Pause
            </Button>
          ))}
        <span className="note">Pausing stops before the next company; the one being evaluated finishes first.</span>
      </div>

      <h3 style={{ margin: 'var(--s4) 0 var(--s2)' }}>Daily limits</h3>
      <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label>
          Companies per night
          <br />
          <input type="number" min={1} max={s.approvedMaxCompanies} value={companies} disabled={!admin} onChange={(e) => setCompanies(e.target.value)} style={{ width: 110 }} />
        </label>
        <label>
          Gemini call ceiling per night
          <br />
          <input type="number" min={0} max={s.approvedMaxCeiling} value={ceiling} disabled={!admin} onChange={(e) => setCeiling(e.target.value)} style={{ width: 130 }} />
        </label>
        <label>
          Retries (% of the night)
          <br />
          <input type="number" min={0} max={50} value={retryShare} disabled={!admin} onChange={(e) => setRetryShare(e.target.value)} style={{ width: 110 }} />
        </label>
        {admin && (
          <Button
            icon={Save}
            disabled={!limitsChanged}
            busy={busy === 'limits'}
            onClick={() => act('limits', () => api.put('/warm-leads/limits', { dailyCompanyLimit: Number(companies), dailyGeminiCeiling: Number(ceiling), retryShare: Number(retryShare) }))}
          >
            Save limits
          </Button>
        )}
      </div>
      <p className="note" style={{ marginTop: 'var(--s2)' }}>
        Approved so far: up to {s.approvedMaxCompanies} companies and {s.approvedMaxCeiling} Gemini calls a night. When the ceiling is reached the night stops safely; a company whose web research could not be finished is marked “research incomplete” — never Cold — and is checked again.
      </p>
      {admin && nextLevel && s.pilotApprovedAt && (
        <div style={{ marginTop: 'var(--s2)' }}>
          <label className="check" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
            <input type="checkbox" checked={scaleOk} onChange={(e) => setScaleOk(e.target.checked)} />
            <span>I reviewed the usage and the accuracy of the results so far and approve raising the allowed level.</span>
          </label>
          <Button disabled={!scaleOk} busy={busy === 'scale'} onClick={() => act('scale', async () => { await api.post('/warm-leads/scale/approve', { level: nextLevel, confirm: true }); setScaleOk(false) })}>
            Allow up to {nextLevel} companies a night (600 Gemini calls)
          </Button>
        </div>
      )}

      <h3 style={{ margin: 'var(--s4) 0 var(--s2)' }}>Processing window</h3>
      <div className="row" style={{ gap: 'var(--s3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label>
          From
          <br />
          <input type="time" value={win.start} disabled={!admin} onChange={(e) => setWin({ ...win, start: e.target.value })} />
        </label>
        <label>
          To
          <br />
          <input type="time" value={win.end} disabled={!admin} onChange={(e) => setWin({ ...win, end: e.target.value })} />
        </label>
        <label>
          Time zone
          <br />
          <input value={win.timezone} disabled={!admin} onChange={(e) => setWin({ ...win, timezone: e.target.value })} style={{ width: 160 }} />
        </label>
        {admin && (
          <Button icon={Save} disabled={!windowChanged} busy={busy === 'window'} onClick={() => act('window', () => api.put('/warm-leads/window', win))}>
            Save window
          </Button>
        )}
      </div>
      <p className="note" style={{ marginTop: 'var(--s2)' }}>
        Default 23:00–06:00 Asia/Kolkata. A night that crosses midnight counts as one night for the daily limits. {o.windowOpenNow ? 'The window is open now.' : 'The window is closed now.'}
      </p>

      <h3 style={{ margin: 'var(--s4) 0 var(--s2)' }}>Companies and retries</h3>
      <div className="row" style={{ gap: 'var(--s2)', flexWrap: 'wrap', alignItems: 'center' }}>
        {admin && (
          <>
            <Button icon={RefreshCw} busy={busy === 'refresh'} disabled={refreshing} onClick={() => act('refresh', () => api.post('/warm-leads/refresh-list', {}))}>
              Read the company list from NXT Sales
            </Button>
            <Button
              icon={RotateCcw}
              busy={busy === 'retry'}
              disabled={o.counts.failed + o.counts.needsReevaluation === 0}
              onClick={() => act('retry', () => api.post('/warm-leads/retry-failed', {}))}
              title="Makes failed and unfinished companies due again; they are retried inside the nightly retry share, separately from new companies."
            >
              Retry failed ({o.counts.failed + o.counts.needsReevaluation})
            </Button>
          </>
        )}
        <span className="note">
          {refreshing ? 'Reading the list… (the worker does this, it can take a minute)' : o.listRefresh.message ? `${o.listRefresh.message} ${fmt(o.listRefresh.refreshedAt)}` : o.listRefresh.refreshedAt ? `Last read ${fmt(o.listRefresh.refreshedAt)}.` : 'The list has not been read yet.'}
        </span>
      </div>
      {o.listRefresh.state === 'failed' && <p className="note note--caveat">{o.listRefresh.message}</p>}

      <h3 style={{ margin: 'var(--s4) 0 var(--s2)' }}>Sending results to NXT Sales</h3>
      <p className="note">
        {s.syncEnabled
          ? `On since ${fmt(s.syncApprovedAt)}: Warm and Early Signal companies are sent to NXT Sales; a company that stops being Warm or Early Signal is taken off its list. Nothing else in the CRM is changed.`
          : 'Off. Results are kept in this application only. Nothing is written to NXT Sales.'}
        {!o.server.syncSwitchOn && ' The server’s own switch for sending (WARM_LEADS_SYNC_ENABLED) is also off.'}
      </p>
      {admin && (
        <div className="row" style={{ gap: 'var(--s2)', marginTop: 'var(--s2)' }}>
          {s.syncEnabled ? (
            <Button busy={busy === 'syncoff'} onClick={() => act('syncoff', () => api.post('/warm-leads/sync/disable', {}))}>Switch sending off</Button>
          ) : (
            <Button
              icon={Send}
              disabled={!s.pilotApprovedAt || !o.server.syncSwitchOn}
              busy={busy === 'syncon'}
              title={!s.pilotApprovedAt ? 'Approve the pilot first.' : !o.server.syncSwitchOn ? 'Enable WARM_LEADS_SYNC_ENABLED on the server first.' : undefined}
              onClick={() => act('syncon', () => api.post('/warm-leads/sync/approve', { confirm: true }))}
            >
              Approve sending to NXT Sales
            </Button>
          )}
        </div>
      )}
    </Panel>
  )
}
