import { useState } from 'react'
import { Check, X, ShieldCheck, Inbox } from 'lucide-react'
import { api, ApiError } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Panel, Button, Chip, Field, StatusBadge, Unset, toUiStatus } from '../components/ui/primitives'
import { BlockedState, EmptyState, ErrorState, LoadingState } from '../components/ui/states'
import { DataTable } from '../components/ui/DataTable'
import { Drawer } from '../components/ui/Evidence'
import { SyncFlow } from '../components/motion/Signatures'
import type { ApprovalDecision, PendingApproval, PendingApprovals as Queue } from '../lib/types'

// PENDING CRM APPROVALS — the human decision, made visible.
//
// This is the step the whole CRM path is built around: the agent qualifies a
// lead and prepares a package, and then stops. Nothing reaches NXT Sales until
// a person reads it and says yes. Until this screen existed, that decision was
// reachable only from an API client, so the safety property was real but
// invisible.
//
// WHAT THIS COMPONENT DOES NOT SEND
//
//   · No approver identity. The backend takes it from the verified JWT, and its
//     request bodies are strict — a field naming a user is rejected outright
//     rather than ignored. There is deliberately no code path here that could
//     put a user id in a request.
//   · No CRM payload. intentScore and qualificationStatus are rebuilt server
//     side from trusted records at delivery time. This screen shows them and
//     offers no way to change them, because a reviewer approves a package, they
//     do not compose one.
//
// The only things travelling with a decision are the concurrency token the
// reviewer was shown and, for a rejection, their reason.

type Busy = 'approve' | 'reject' | null

/** What happened, in the words the backend used. */
interface Outcome {
  decision: ApprovalDecision
  company: string
}

/** Turns a failed decision into something a reviewer can act on. */
function explain(err: unknown): { title: string; detail: string; kind: 'stale' | 'decided' | 'denied' | 'gone' | 'other' } {
  if (!(err instanceof ApiError)) {
    return {
      title: 'The decision could not be recorded',
      detail: (err as Error)?.message ?? 'The request did not complete.',
      kind: 'other',
    }
  }
  if (err.status === 409) {
    // The route distinguishes these, and they need different responses from
    // the reviewer: reload and re-read, versus somebody already answered.
    const stale = /changed since you loaded it/i.test(err.message)
    return stale
      ? {
          title: 'This handoff changed while you were reading it',
          detail:
            'It was re-synced, retried or decided by someone else since this page loaded. Reload the queue and review the current package before deciding.',
          kind: 'stale',
        }
      : {
          title: 'Already decided',
          detail: err.message,
          kind: 'decided',
        }
  }
  if (err.status === 403) {
    return { title: 'You cannot decide this one', detail: err.message, kind: 'denied' }
  }
  if (err.status === 404) {
    return { title: 'This handoff no longer exists', detail: err.message, kind: 'gone' }
  }
  return { title: 'The decision could not be recorded', detail: err.message, kind: 'other' }
}

export function PendingApprovals({ accent }: { accent: string }) {
  const { can, principal } = useAuth()
  const queue = useAsync<Queue>((signal) => api.get('/crm-sync/approvals/pending', { signal }), [])

  const [open, setOpen] = useState<PendingApproval | null>(null)
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [failure, setFailure] = useState<ReturnType<typeof explain> | null>(null)

  const close = () => {
    setOpen(null)
    setReason('')
    setNote('')
    setFailure(null)
    setOutcome(null)
  }

  const review = (row: PendingApproval) => {
    setOpen(row)
    setReason('')
    setNote('')
    setFailure(null)
    setOutcome(null)
  }

  const decide = async (kind: 'approve' | 'reject') => {
    if (!open) return
    if (kind === 'reject' && !reason.trim()) return
    setBusy(kind)
    setFailure(null)
    try {
      // The body carries the concurrency token and the reviewer's own words.
      // Nothing else. No identity, no score, no status, no owner.
      const body =
        kind === 'approve'
          ? { expectedUpdatedAt: open.expectedUpdatedAt, ...(note.trim() ? { note: note.trim() } : {}) }
          : { expectedUpdatedAt: open.expectedUpdatedAt, reason: reason.trim() }

      const decision = await api.post<ApprovalDecision>(`/crm-sync/approvals/${open.syncId}/${kind}`, body)
      setOutcome({ decision, company: open.companyName ?? open.crmCompanyId })
    } catch (err) {
      setFailure(explain(err))
    } finally {
      setBusy(null)
      // The queue is re-read either way. A failure usually means the record
      // moved, which is exactly when a stale list is most misleading.
      queue.refresh()
    }
  }

  if (queue.error) {
    const err = queue.error
    if (err instanceof ApiError && err.isUnauthorized) {
      return (
        <Panel title="Pending CRM approvals">
          <BlockedState
            what="Not signed in"
            why="Reading the approval queue requires a signed-in session."
            affects="No pending handoff can be listed or decided."
            remediation="Sign in with your NXT Sales account."
          />
        </Panel>
      )
    }
    return (
      <Panel title="Pending CRM approvals">
        <ErrorState
          error={err}
          what="Reading the queue of handoffs waiting for a decision"
          affects="Pending approvals cannot be listed. Nothing has been written to NXT Sales."
          onRetry={queue.refresh}
        />
      </Panel>
    )
  }

  const rows = queue.data?.pending ?? []

  // APPROVED is the decision a person made. WRITTEN is what the CRM actually
  // received. They are not the same thing — with CRM_WRITE_ENABLED off, an
  // approval is genuinely recorded and NXT Sales is genuinely untouched — and
  // the interface must not blur them into one green tick.
  const written = outcome?.decision.state === 'synced'

  return (
    <>
      <Panel
        title="Pending CRM approvals"
        subtitle={
          queue.data
            ? `${queue.data.count} handoff${queue.data.count === 1 ? '' : 's'} waiting for a person`
            : 'Handoffs waiting for a person'
        }
        padded={rows.length === 0}
      >
        {queue.loading && !queue.data ? (
          <LoadingState what="Reading the approval queue" visual={<SyncFlow accent={accent} blocked />} rows={3} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="Nothing waiting for a decision"
            detail="A qualified lead appears here once its handoff has been prepared. Nothing is written to NXT Sales until someone approves it."
          />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.syncId}
            onRowClick={(r) => review(r)}
            columns={[
              {
                key: 'company',
                header: 'Company',
                render: (r) => <span className="cell-strong">{r.companyName ?? r.crmCompanyId}</span>,
              },
              {
                key: 'status',
                header: 'Qualification',
                render: (r) => (
                  <StatusBadge status={toUiStatus(r.qualification.status)} label={r.qualification.status.replace(/_/g, ' ')} size="sm" />
                ),
              },
              { key: 'score', header: 'Intent', render: (r) => <span className="mono">{r.qualification.score}</span> },
              {
                key: 'owner',
                header: 'Owner',
                render: (r) => <span className="cell-dim">{r.owner.crmUserId ?? r.owner.status.replace(/_/g, ' ')}</span>,
              },
              {
                key: 'prepared',
                header: 'Prepared',
                render: (r) => (
                  <span className="cell-dim">{r.preparedAt ? new Date(r.preparedAt).toLocaleString() : '—'}</span>
                ),
              },
              {
                key: 'by',
                header: 'Prepared by',
                render: (r) =>
                  r.requestedByCrmUserId ? (
                    <span className="cell-dim mono">{r.youPreparedThis ? 'you' : r.requestedByCrmUserId}</span>
                  ) : (
                    <span className="cell-dim">—</span>
                  ),
              },
              {
                key: 'validation',
                header: 'Validation',
                render: (r) => (
                  <Chip tone={r.validation.ok ? 'ok' : 'danger'}>{r.validation.ok ? 'validated' : 'failed'}</Chip>
                ),
              },
            ]}
          />
        )}
      </Panel>

      <Drawer
        open={Boolean(open)}
        onClose={close}
        title={open?.companyName ?? open?.crmCompanyId ?? 'Review handoff'}
        subtitle={outcome ? 'Decision recorded' : 'Review before it reaches NXT Sales'}
        width={620}
      >
        {open && (
          <div className="stack">
            {/* ── The decision has been made ────────────────────────────── */}
            {outcome ? (
              <>
                <div className="node-reveal" style={{ ['--i' as string]: 0 }}>
                  <Panel
                    title={outcome.decision.decision === 'approved' ? 'Approved' : 'Rejected'}
                    subtitle={outcome.company}
                  >
                    <div className="row" style={{ marginBottom: 'var(--s3)' }}>
                      <StatusBadge
                        status={
                          outcome.decision.decision !== 'approved' ? 'error' : written ? 'complete' : 'blocked'
                        }
                        label={outcome.decision.stateLabel}
                      />
                    </div>
                    {/* The backend's own words about what happened. Nothing here
                        claims a CRM write that the response did not report. */}
                    <p className="note">{outcome.decision.reason}</p>

                    {outcome.decision.decision === 'approved' && outcome.decision.resources && (
                      <div style={{ marginTop: 'var(--s4)' }}>
                        <DataTable
                          rows={outcome.decision.resources}
                          rowKey={(r) => r.resource}
                          columns={[
                            { key: 'resource', header: 'CRM object', render: (r) => <span className="cell-strong">{r.resource}</span> },
                            {
                              key: 'result',
                              header: 'Result',
                              render: (r) => (
                                <StatusBadge status={toUiStatus(r.result)} label={r.result.replace(/_/g, ' ')} size="sm" />
                              ),
                            },
                            { key: 'why', header: 'Detail', render: (r) => <span className="cell-dim">{r.reason ?? '—'}</span> },
                          ]}
                        />
                      </div>
                    )}
                  </Panel>
                </div>

                {/* The flow reflects whether the CRM was WRITTEN, not merely
                    whether a person said yes. An approval with writes switched
                    off is a real approval and an untouched CRM, and drawing a
                    delivered packet there would be the interface claiming
                    something the backend did not report. */}
                <div className="node-reveal" style={{ ['--i' as string]: 1 }}>
                  <div className="sync">
                    <div className="sync__end">
                      <span className="sync__endlabel">Marketing AI</span>
                      <span className="sync__endsub">{outcome.company}</span>
                    </div>
                    <div className="sync__pipe">
                      <SyncFlow accent={accent} blocked={!written} />
                      <span className={`sync__verdict${written ? ' is-ok' : ' is-blocked'}`}>
                        {outcome.decision.stateLabel}
                      </span>
                    </div>
                    <div className={`sync__end sync__end--target${written ? '' : ' is-blocked'}`}>
                      <span className="sync__endlabel">NXT Sales</span>
                      <span className="sync__endsub">{written ? 'updated' : 'not written'}</span>
                    </div>
                  </div>
                </div>

                <div className="row">
                  <Button variant="primary" onClick={close}>
                    Back to the queue
                  </Button>
                </div>
              </>
            ) : (
              <>
                {/* ── What is being decided ──────────────────────────────── */}
                <Panel title="What the agent concluded">
                  <Field
                    label="Qualification"
                    value={
                      <StatusBadge
                        status={toUiStatus(open.qualification.status)}
                        label={open.qualification.status.replace(/_/g, ' ')}
                        size="sm"
                      />
                    }
                  />
                  <Field label="Intent score" value={<span className="mono">{open.qualification.score}</span>} />
                  <Field label="Owner" value={open.owner.crmUserId ?? open.owner.status.replace(/_/g, ' ')} />
                  <Field
                    label="Prepared"
                    value={open.preparedAt ? new Date(open.preparedAt).toLocaleString() : <Unset />}
                  />
                  <Field
                    label="Prepared by"
                    value={
                      open.requestedByCrmUserId ? (
                        <span className="mono">{open.youPreparedThis ? 'you' : open.requestedByCrmUserId}</span>
                      ) : (
                        <Unset what="Not recorded" />
                      )
                    }
                  />
                  <Field
                    label="Validation"
                    value={
                      <Chip tone={open.validation.ok ? 'ok' : 'danger'}>
                        {open.validation.ok ? 'validated' : 'failed'}
                      </Chip>
                    }
                  />
                  <p className="note" style={{ marginTop: 'var(--s3)' }}>
                    {open.qualification.reason}
                  </p>
                </Panel>

                {/* ── What would be written ──────────────────────────────── */}
                <Panel title="What would be written" subtitle="Two Company fields. Nothing else.">
                  <p className="note">
                    Approving records your decision and lets the platform update this Company's{' '}
                    <span className="mono">intentScore</span> and <span className="mono">qualificationStatus</span>. Both
                    values are rebuilt from the qualification at the moment of writing and cannot be edited here — a
                    reviewer approves a package rather than composing one. No owner, no lead status, and no Deal field is
                    ever sent.
                  </p>
                </Panel>

                {/* ── The decision ───────────────────────────────────────── */}
                {!can('approve') ? (
                  <BlockedState
                    what="You cannot sign this off"
                    why={`Deciding a CRM handoff requires the "approve" permission; your role is "${principal?.role ?? 'unknown'}".`}
                    affects="You can read the queue, but not approve or reject."
                    remediation="Ask an administrator to grant your account the approver role."
                  />
                ) : open.youPreparedThis ? (
                  <BlockedState
                    what="You prepared this handoff"
                    why="An approval is a second person agreeing, so the person who raised a handoff cannot also approve it."
                    affects="This one decision. You can still reject it, which takes it out of the queue."
                    remediation="Ask a colleague with the approver role to review it."
                    action={
                      <Button
                        icon={X}
                        onClick={() => decide('reject')}
                        busy={busy === 'reject'}
                        disabled={!reason.trim()}
                        title={!reason.trim() ? 'A reason is required to reject' : undefined}
                      >
                        Reject
                      </Button>
                    }
                  />
                ) : null}

                <Panel title="Decision" subtitle={`Signing as ${principal?.name ?? principal?.email ?? 'you'}`}>
                  <label className="field-label" htmlFor="crm-approval-note">
                    Note <span className="field-hint">Optional. Recorded with an approval.</span>
                  </label>
                  <textarea
                    id="crm-approval-note"
                    className="textarea"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="What did you check?"
                  />

                  <label className="field-label" htmlFor="crm-approval-reason" style={{ marginTop: 'var(--s4)' }}>
                    Reason <span className="field-hint">Required to reject</span>
                  </label>
                  <textarea
                    id="crm-approval-reason"
                    className="textarea"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    rows={3}
                    placeholder="Why should this lead not go to the CRM?"
                  />

                  <div className="row" style={{ marginTop: 'var(--s4)' }}>
                    <Button
                      variant="primary"
                      icon={Check}
                      onClick={() => decide('approve')}
                      busy={busy === 'approve'}
                      disabled={!can('approve') || open.youPreparedThis}
                    >
                      Approve
                    </Button>
                    <Button
                      icon={X}
                      onClick={() => decide('reject')}
                      busy={busy === 'reject'}
                      disabled={!can('approve') || !reason.trim()}
                      title={!reason.trim() ? 'A reason is required to reject' : undefined}
                    >
                      Reject
                    </Button>
                  </div>

                  {failure && (
                    <div className="node-reveal" style={{ ['--i' as string]: 0, marginTop: 'var(--s4)' }}>
                      <BlockedState
                        what={failure.title}
                        why={failure.detail}
                        affects={
                          failure.kind === 'stale' || failure.kind === 'decided'
                            ? 'Nothing was written to NXT Sales.'
                            : 'This decision was not recorded.'
                        }
                        remediation={
                          failure.kind === 'stale' || failure.kind === 'decided'
                            ? 'Close this panel and reopen the handoff from the refreshed queue.'
                            : 'Try again, or ask an administrator if it keeps failing.'
                        }
                      />
                    </div>
                  )}
                </Panel>
              </>
            )}
          </div>
        )}
      </Drawer>
    </>
  )
}

/** The queue as its own entry point, for when no company is selected. */
export function ApprovalQueueStandalone({ accent }: { accent: string }) {
  return (
    <div className="stack">
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <ShieldCheck size={16} aria-hidden="true" />
        <span className="note">
          Every qualified lead stops here for a person. Nothing reaches NXT Sales without an approval.
        </span>
      </div>
      <PendingApprovals accent={accent} />
      <div className="row" style={{ gap: 'var(--s2)' }}>
        <Inbox size={14} aria-hidden="true" />
        <span className="note note--caveat">
          Select a company from the header to prepare a new handoff or inspect one already synchronised.
        </span>
      </div>
    </div>
  )
}
