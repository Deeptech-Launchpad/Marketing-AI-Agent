import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Chip, Button, Field, Unset, StatusBadge, toUiStatus } from '../components/ui/primitives'
import { BlockedState, EmptyState, ErrorState, LoadingState } from '../components/ui/states'
import type { ApprovalEvent, ApprovalState } from '../lib/types'
import { Check, ShieldCheck, X } from 'lucide-react'

// Human Approval (#980).
//
// The reviewer is taken from the authenticated session, never from a form —
// so the interface has no field for "who is approving", by design. Approval
// is a decision with a name attached, and that name comes from the token.

const RECENT_KEY = 'altiusnxt.marketing.recentAuditRun'

const STEPS = [
  { key: 'generated', label: 'Report generated' },
  { key: 'ready_for_approval', label: 'Ready for approval' },
  { key: 'approved', label: 'Signed off' },
]

export function Approval() {
  const engine = useEngine('approval')
  const { can, principal } = useAuth()
  const [params] = useSearchParams()
  const [busy, setBusy] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [actionError, setActionError] = useState<Error | null>(null)

  const runId = params.get('run') ?? (typeof localStorage !== 'undefined' ? localStorage.getItem(RECENT_KEY) : null)

  const state = useAsync<ApprovalState | null>(
    (signal) => (runId ? api.get(`/website-audit/runs/${runId}/approval`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [runId],
    { enabled: Boolean(runId) },
  )
  const history = useAsync<{ events: ApprovalEvent[] }>(
    (signal) => api.get(`/website-audit/runs/${runId}/approval/history`, { signal }),
    [runId],
    { enabled: Boolean(runId) },
  )

  const decide = async (action: 'approve' | 'request_changes' | 'reject' | 'submit') => {
    if (!runId || !state.data) return
    setBusy(action)
    setActionError(null)
    try {
      await api.post(`/website-audit/runs/${runId}/approval`, {
        action,
        reason: reason || undefined,
        // Optimistic concurrency: the backend refuses a stale write, so two
        // reviewers cannot overwrite one another.
        lockVersion: state.data.lockVersion,
      })
      setReason('')
      state.refresh()
      history.refresh()
    } catch (err) {
      setActionError(err as Error)
    } finally {
      setBusy(null)
    }
  }

  const status = state.data?.status ?? ''
  const isApproved = status === 'approved'
  const stepIndex = isApproved ? 2 : status === 'ready_for_approval' ? 1 : 0

  return (
    <EnginePage engineId="approval" state={isApproved ? 'success' : busy ? 'running' : 'idle'}>
      {!runId ? (
        <EmptyState title="No report to review" detail="Open an audit run first; its report is what gets approved." />
      ) : state.loading && !state.data ? (
        <LoadingState what="Reading the approval state" rows={3} />
      ) : !state.data ? (
        <EmptyState
          title="No report for this run"
          detail="A report has not been generated for this audit yet. Generate one in the Audit Report workspace."
        />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel title="Approval workflow" subtitle="A named reviewer signs off before anything customer-facing is built">
                <ol className="steps">
                  {STEPS.map((s, i) => (
                    <li
                      key={s.key}
                      className={`steps__item${i < stepIndex ? ' is-done' : i === stepIndex ? ' is-current' : ''}`}
                      style={{ ['--e' as string]: engine.accent }}
                    >
                      <span className="steps__mark">{i < stepIndex ? <Check size={12} /> : i + 1}</span>
                      <span className="steps__label">{s.label}</span>
                    </li>
                  ))}
                </ol>

                {isApproved && (
                  <div className="approved" style={{ ['--e' as string]: engine.accent }}>
                    <span className="approved__halo" aria-hidden="true" />
                    <ShieldCheck size={26} aria-hidden="true" />
                    <div>
                      <p className="approved__title">Approved</p>
                      <p className="approved__sub">
                        Revision {state.data.approvedRevision} signed off
                        {state.data.reviewerEmail ? ` by ${state.data.reviewerEmail}` : ''}
                        {state.data.reviewedAt ? ` on ${new Date(state.data.reviewedAt).toLocaleString()}` : ''}.
                      </p>
                    </div>
                  </div>
                )}
              </Panel>

              {actionError && (
                <ErrorState
                  error={actionError}
                  what="The decision was not recorded"
                  affects="The report status is unchanged."
                  onRetry={() => setActionError(null)}
                />
              )}

              {!can('approve') ? (
                <BlockedState
                  what="You cannot approve this report"
                  why={`Approval requires the "approve" permission; your role is "${principal?.role ?? 'unknown'}".`}
                  affects="You can read the report and its history, but not sign it off."
                  remediation="Ask an administrator to grant your account the approver role."
                />
              ) : isApproved ? (
                <Panel title="Decision">
                  <p className="note">
                    This report is approved and cannot be edited. Reopening it starts a new revision cycle and preserves
                    the approved one.
                  </p>
                </Panel>
              ) : (
                <Panel title="Decision" subtitle={`Signing as ${principal?.name ?? 'you'}`}>
                  <label className="field-label" htmlFor="approval-reason">
                    Reason <span className="field-hint">Required when requesting changes or rejecting</span>
                  </label>
                  <textarea
                    id="approval-reason"
                    className="textarea"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    placeholder="What did you check, and what needs to change?"
                  />
                  <div className="row" style={{ marginTop: 'var(--s4)' }}>
                    <Button variant="primary" icon={Check} onClick={() => decide('approve')} busy={busy === 'approve'}>
                      Approve
                    </Button>
                    <Button
                      icon={X}
                      onClick={() => decide('request_changes')}
                      busy={busy === 'request_changes'}
                      disabled={!reason.trim()}
                      title={!reason.trim() ? 'A reason is required to request changes' : undefined}
                    >
                      Request changes
                    </Button>
                  </div>
                </Panel>
              )}
            </>
          }
          side={
            <>
              <Panel title="Report">
                <Field label="Status" value={<StatusBadge status={toUiStatus(status)} label={status.replace(/_/g, ' ')} size="sm" />} />
                <Field label="Current revision" value={state.data.currentRevision} />
                <Field label="Approved revision" value={state.data.approvedRevision ?? <Unset what="None" />} />
                <Field label="Reviewer" value={state.data.reviewerEmail ?? <Unset what="Not reviewed" />} />
                <Field label="Lock version" value={state.data.lockVersion} mono />
              </Panel>

              <Panel title="Decision history" subtitle="Append-only">
                {history.data?.events?.length ? (
                  <ol className="history">
                    {history.data.events.map((e, i) => (
                      <li key={e.id} className="history__item node-reveal" style={{ ['--i' as string]: i }}>
                        <Chip tone={e.toStatus === 'approved' ? 'ok' : e.toStatus === 'rejected' ? 'danger' : 'neutral'}>
                          {e.action.replace(/_/g, ' ')}
                        </Chip>
                        <span className="history__meta">
                          <span className="history__when mono">{new Date(e.occurredAt).toLocaleString()}</span>
                          <span className="history__trigger">{e.reviewerEmail ?? 'system'}</span>
                          {e.reason && <span className="history__reason">{e.reason}</span>}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <Unset what="No decision recorded yet" />
                )}
              </Panel>
            </>
          }
        />
      )}
    </EnginePage>
  )
}
