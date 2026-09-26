import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, MessageSquare } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Unset } from '../../components/ui/primitives'
import { useCall } from './useCall'
import { REPLY_LABEL, fmtDateTime, type CompanySequence, type Reply, type ReplyClass } from './types'

// REPLIES — PASTED BY SALES, READ BY THE AI, CONFIRMED BY SALES.
//
// The AI suggests what kind of reply it is, quoting the sentence it relied on
// and listing any SKUs exactly as they appear in the reply. Nothing changes in
// the sequence until a person confirms (or corrects) that reading. When the
// reply is unclear, the AI says so rather than guessing, and Sales decides.

const CLASSES = Object.keys(REPLY_LABEL) as ReplyClass[]

function todayLocal(): string {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 16)
}

export function ReplyPanel({ view, onChanged, canOperate }: { view: CompanySequence; onChanged: () => void; canOperate: boolean }) {
  const call = useCall(onChanged)
  const [text, setText] = useState('')
  const [receivedAt, setReceivedAt] = useState(todayLocal)
  const campaignId = view.campaign?.id
  const initialSent = Boolean(view.sequence?.initialSentAt)
  const pending = view.replies.filter((r) => !r.confirmedAt)
  const confirmed = view.replies.filter((r) => r.confirmedAt)

  if (!campaignId) return null

  return (
    <div className="otr-replies">
      {call.error && (
        <p className="otr-err" role="alert">
          <AlertTriangle size={13} aria-hidden="true" /> {call.error}
        </p>
      )}

      {pending.map((r) => (
        <PendingReply key={r.id} reply={r} onChanged={onChanged} canOperate={canOperate} />
      ))}

      {confirmed.map((r) => (
        <div key={r.id} className="otr-reply is-confirmed">
          <div className="row">
            <Chip tone="ok">{r.classification ? REPLY_LABEL[r.classification] : 'Confirmed'}</Chip>
            <span className="cell-dim">
              Received {fmtDateTime(r.receivedAt)} · confirmed {fmtDateTime(r.confirmedAt)}
              {r.confirmedBy ? ` by ${r.confirmedBy}` : ''}
            </span>
          </div>
          <blockquote className="otr-reply__text">{r.text}</blockquote>
          {r.skus.length > 0 && <p className="note">SKUs: {r.skus.join(' · ')}</p>}
        </div>
      ))}

      {canOperate && initialSent && (
        <div className="otr-reply__new">
          <label className="field-label" htmlFor="reply-text">
            Paste the prospect&rsquo;s reply
          </label>
          <textarea id="reply-text" className="textarea" rows={5} value={text} onChange={(e) => setText(e.target.value)} />
          <label className="field-label" htmlFor="reply-at" style={{ marginTop: 'var(--s2)' }}>
            Received
          </label>
          <input id="reply-at" className="otr-input" type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          <div className="row" style={{ marginTop: 'var(--s2)' }}>
            <Button
              icon={MessageSquare}
              disabled={!text.trim() || !receivedAt}
              busy={call.busy === 'add'}
              onClick={() =>
                void call
                  .run('add', () => api.post(`/outreach/sequence/campaigns/${campaignId}/replies`, { text, receivedAt: new Date(receivedAt).toISOString() }))
                  .then((ok) => ok && setText(''))
              }
            >
              Read reply
            </Button>
          </div>
        </div>
      )}
      {!initialSent && <p className="note">Replies can be recorded once the initial email has been marked sent.</p>}
      {initialSent && view.replies.length === 0 && !canOperate && <Unset what="No reply recorded" />}
    </div>
  )
}

function PendingReply({ reply, onChanged, canOperate }: { reply: Reply; onChanged: () => void; canOperate: boolean }) {
  const call = useCall(onChanged)
  const suggested = reply.modelClassification ?? 'unclear'
  const [choice, setChoice] = useState<ReplyClass>(suggested)
  const [skus, setSkus] = useState<string>(reply.modelSkus.join('\n'))
  useEffect(() => {
    setChoice(reply.modelClassification ?? 'unclear')
    setSkus(reply.modelSkus.join('\n'))
  }, [reply.id, reply.modelClassification, reply.modelSkus])

  const skuList = skus
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)

  return (
    <div className="otr-reply is-pending">
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      <div className="row">
        <Chip tone="warn">Awaiting confirmation</Chip>
        <span className="cell-dim">Received {fmtDateTime(reply.receivedAt)}</span>
      </div>
      <blockquote className="otr-reply__text">{reply.text}</blockquote>
      <p className="note">
        AI reading: <strong>{REPLY_LABEL[suggested]}</strong>
        {reply.modelEvidenceQuote ? <> — because the reply says &ldquo;{reply.modelEvidenceQuote}&rdquo;</> : null}
      </p>
      {reply.modelChecks.length > 0 && (
        <ul className="otr-list">
          {reply.modelChecks.map((c, i) => (
            <li key={i} className="cell-dim">
              {c}
            </li>
          ))}
        </ul>
      )}
      {canOperate && (
        <>
          <label className="field-label" htmlFor={`cls-${reply.id}`} style={{ marginTop: 'var(--s2)' }}>
            What kind of reply is it?
          </label>
          <select id={`cls-${reply.id}`} className="otr-input" value={choice} onChange={(e) => setChoice(e.target.value as ReplyClass)}>
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {REPLY_LABEL[c]}
              </option>
            ))}
          </select>
          {choice === 'sent_skus' && (
            <>
              <label className="field-label" htmlFor={`skus-${reply.id}`} style={{ marginTop: 'var(--s2)' }}>
                SKUs from the reply (one per line, exactly as written)
              </label>
              <textarea id={`skus-${reply.id}`} className="textarea" rows={5} value={skus} onChange={(e) => setSkus(e.target.value)} />
            </>
          )}
          <div className="row" style={{ marginTop: 'var(--s2)' }}>
            <Button
              icon={CheckCircle2}
              variant="primary"
              disabled={choice === 'unclear'}
              title={choice === 'unclear' ? 'Choose what kind of reply this is' : undefined}
              busy={call.busy === 'confirm'}
              onClick={() =>
                void call.run('confirm', () =>
                  api.post(`/outreach/sequence/replies/${reply.id}/confirm`, choice === 'sent_skus' ? { classification: choice, skus: skuList } : { classification: choice }),
                )
              }
            >
              Confirm reading
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
