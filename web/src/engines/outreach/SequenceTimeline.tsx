import { useState } from 'react'
import { FileEdit, SkipForward } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Unset } from '../../components/ui/primitives'
import { useCall } from './useCall'
import { emailStatus, stepStatus } from './status'
import { fmtDateTime, fmtWindow, type CompanySequence, type Draft } from './types'

// THE SEQUENCE, STAGE BY STAGE.
//
// Every stage of the approved sequence, in the order the PDF gives them, with
// its status, its due window and — when it does not apply — why. A stage is
// prepared from here once the sequence allows it; nothing is prepared, and
// nothing is sent, on its own.

const TRACK: Record<string, string> = { initial: 'First email', no_reply: 'Follow-up if no reply', reply: 'After they reply' }

export function SequenceTimeline({
  view,
  onOpenDraft,
  onChanged,
  canOperate,
}: {
  view: CompanySequence
  onOpenDraft: (d: Draft) => void
  onChanged: () => void
  canOperate: boolean
}) {
  const call = useCall(onChanged)
  const [skipping, setSkipping] = useState<string | null>(null)
  const [skipReason, setSkipReason] = useState('')
  const seq = view.sequence
  const campaignId = view.campaign?.id
  if (!seq || !campaignId) return null

  const draftFor = (stageKey: string) => view.drafts.find((d) => d.stageKey === stageKey && d.status !== 'cancelled') ?? null

  return (
    <div className="otr-tl">
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      <ol className="otr-tl__list">
        {seq.stages.map((s) => {
          const d = draftFor(s.stageKey)
          return (
            <li key={s.stageKey} className={`otr-tl__item is-${s.status}`}>
              <div className="otr-tl__head">
                <span className="otr-tl__ref mono">{s.pdfRef}</span>
                <span className="otr-tl__name">{s.label}</span>
                {(() => {
                  const st = d ? emailStatus(d.status, d.statusReason, Boolean(view.campaign?.isTest)) : stepStatus(s.status)
                  return <Chip tone={st.tone}>{st.label}</Chip>
                })()}
                <span className="cell-dim">{TRACK[s.track] ?? s.track}</span>
              </div>
              <div className="otr-tl__meta">
                {s.window ? <span>Due {fmtWindow(s.window)}</span> : null}
                {d?.scheduledAt ? <span>Test send {fmtDateTime(d.scheduledAt)}</span> : null}
                {d?.sentAt ? <span>{d.sentVia === 'platform_test' ? 'Sent (test)' : 'Sent'} {fmtDateTime(d.sentAt)}</span> : null}
                {d?.version ? <span>Version {d.version.toUpperCase()}</span> : null}
                {s.reason ? <span className="cell-dim">{s.reason}</span> : null}
              </div>
              {canOperate && (
                <div className="row otr-tl__actions">
                  {d ? (
                    <Button size="sm" icon={FileEdit} onClick={() => onOpenDraft(d)}>
                      {d.status === 'draft' ? 'Review & approve' : 'Open'}
                    </Button>
                  ) : (
                    s.canPrepare && (
                      <Button
                        size="sm"
                        icon={FileEdit}
                        variant="primary"
                        busy={call.busy === `prep-${s.stageKey}`}
                        onClick={() => void call.run(`prep-${s.stageKey}`, () => api.post(`/outreach/sequence/campaigns/${campaignId}/stages/${s.stageKey}/prepare`, {}))}
                      >
                        Prepare draft
                      </Button>
                    )
                  )}
                  {(s.status === 'due' || s.status === 'overdue' || s.status === 'drafted' || s.status === 'upcoming') && s.stageKey !== 'initial' && (
                    <Button size="sm" variant="quiet" icon={SkipForward} onClick={() => { setSkipping(s.stageKey); setSkipReason('') }}>
                      Skip
                    </Button>
                  )}
                </div>
              )}
              {skipping === s.stageKey && (
                <div className="otr-tl__skip">
                  <label className="field-label" htmlFor={`skip-${s.stageKey}`}>
                    Why is this stage being skipped?
                  </label>
                  <input id={`skip-${s.stageKey}`} className="otr-input" value={skipReason} onChange={(e) => setSkipReason(e.target.value)} />
                  <div className="row" style={{ marginTop: 'var(--s2)' }}>
                    <Button
                      size="sm"
                      busy={call.busy === `skip-${s.stageKey}`}
                      onClick={() =>
                        void call
                          .run(`skip-${s.stageKey}`, () => api.post(`/outreach/sequence/campaigns/${campaignId}/stages/${s.stageKey}/skip`, { reason: skipReason }))
                          .then((ok) => ok && setSkipping(null))
                      }
                    >
                      Confirm skip
                    </Button>
                    <Button size="sm" variant="quiet" onClick={() => setSkipping(null)}>
                      Keep it
                    </Button>
                  </div>
                </div>
              )}
            </li>
          )
        })}
      </ol>
      {seq.reminders.length > 0 && (
        <div className="otr-tl__reminders">
          {seq.reminders.map((r, i) => (
            <p key={i} className="note">
              {r.label}
              {r.window ? ` — ${fmtWindow(r.window)}` : ''}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** The outreach history: every change, who made it and when. */
export function OutreachHistory({ view }: { view: CompanySequence }) {
  if (view.history.length === 0) return <Unset what="Nothing recorded yet" />
  return (
    <ul className="otr-hist">
      {view.history.map((h) => (
        <li key={h.id}>
          <span className="otr-hist__at tnum">{fmtDateTime(h.at)}</span>
          <span className="otr-hist__what">{h.summary}</span>
          {h.by && <span className="cell-dim">{h.by}</span>}
        </li>
      ))}
    </ul>
  )
}
