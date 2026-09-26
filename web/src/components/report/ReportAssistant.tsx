import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Copy, FileEdit, Send, Sparkles } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Panel } from '../ui/primitives'
import './reportAssistant.css'

// THE AUDIT ASSISTANT — ON THE REPORT IT IS ABOUT.
//
// Not a general chatbot. Every answer is grounded in THIS audit — its findings,
// scorecard, roadmap and hero product — and everything it produces arrives
// already checked: figures the audit does not contain and unsupported claims
// are shown on the draft rather than hidden.
//
// It can PROPOSE a change to the report's wording. Applying one is a separate,
// explicit click by someone with the approve permission, and it goes through
// the same revision route the Approval screen uses — which stores a new
// revision, re-validates it, and leaves approval to a reviewer. Nothing here
// edits a report directly.

interface Draft {
  kind: string
  title: string
  content: string
  ungroundedFigures: string[]
  claimViolations: Array<{ pattern: string; match: string; why: string }>
}

interface ProposedEdit {
  changeReason: string
  edit: { headline?: string; summary?: string; nextStep?: string }
  current: { headline?: string; summary?: string; nextStep?: string }
  blocked: boolean
  blockedReasons: string[]
}

interface Answer {
  reply: string
  drafts: Draft[]
  proposedEdit: ProposedEdit | null
  citations: string[]
  warnings: string[]
}

type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; answer: Answer }
  | { role: 'error'; content: string }

interface ApprovalSnapshot {
  lockVersion: number
  currentRevision: number
  canEdit: boolean
}

/** What Sales usually asks first. Each one is answerable from the audit alone. */
const SUGGESTIONS = [
  'What are the biggest problems on their product page, and why do they matter?',
  'Draft an improved product description for the audited product.',
  'Build a structured specification table for the audited product.',
  'Write a short email to the customer summarising the audit.',
  'Tighten the report’s summary so it leads with the most important finding.',
]

const FIELD_LABEL: Record<string, string> = { headline: 'Headline', summary: 'Executive summary', nextStep: 'Next step' }

export function ReportAssistant({
  runId,
  canOperate,
  canApprove,
  onRevised,
}: {
  runId: string
  canOperate: boolean
  canApprove: boolean
  /** Called after a proposed edit is saved as a new revision. */
  onRevised?: () => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)

  // Keeps the newest message in view by scrolling the LOG, never the page.
  // scrollIntoView on mount would drag the whole Audit Report down to this
  // panel the moment the screen opened, before anyone had asked anything — so
  // nothing happens until there is a conversation to follow.
  useEffect(() => {
    const log = logRef.current
    if (!log || messages.length === 0) return
    log.scrollTop = log.scrollHeight
  }, [messages, busy])

  const ask = async (text: string) => {
    const message = text.trim()
    if (!message || busy) return
    const history = messages
      .filter((m): m is Exclude<Message, { role: 'error' }> => m.role !== 'error')
      .map((m) => ({ role: m.role, content: m.content }))
    setMessages((m) => [...m, { role: 'user', content: message }])
    setInput('')
    setBusy(true)
    try {
      const answer = await api.post<Answer>(`/website-audit/runs/${runId}/assistant`, { message, history })
      setMessages((m) => [...m, { role: 'assistant', content: answer.reply, answer }])
    } catch (err) {
      setMessages((m) => [...m, { role: 'error', content: (err as Error).message }])
    } finally {
      setBusy(false)
    }
  }

  if (!canOperate) {
    return (
      <Panel title="Audit assistant" subtitle="Ask about this audit, draft outputs, and propose report changes">
        <p className="rasst__locked">The audit assistant needs the operate permission, which your account does not hold.</p>
      </Panel>
    )
  }

  return (
    <Panel
      title={
        <span className="rasst__title">
          <Sparkles size={16} aria-hidden="true" /> Audit assistant
        </span>
      }
      subtitle="Grounded in this audit only — its findings, scorecard, roadmap and audited product"
    >
      <div className="rasst">
        {messages.length === 0 && (
          <div className="rasst__intro">
            <p>
              Ask about what the audit found, or have it draft something from the findings. It answers only from this
              audit and says so when the audit does not contain the answer. Report changes are proposed here and saved
              as a new revision for review — never applied directly.
            </p>
            <div className="rasst__suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="rasst__chip" onClick={() => ask(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rasst__log" aria-live="polite" ref={logRef}>
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="rasst__msg rasst__msg--user">
                {m.content}
              </div>
            ) : m.role === 'error' ? (
              <div key={i} className="rasst__msg rasst__msg--error">
                <AlertTriangle size={14} aria-hidden="true" /> {m.content}
              </div>
            ) : (
              <AssistantMessage key={i} runId={runId} answer={m.answer} canApprove={canApprove} onRevised={onRevised} />
            ),
          )}
          {busy && <div className="rasst__msg rasst__msg--thinking">Reading the audit…</div>}
        </div>

        <form
          className="rasst__input"
          onSubmit={(e) => {
            e.preventDefault()
            void ask(input)
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void ask(input)
              }
            }}
            placeholder="Ask about this audit, or ask for a draft…"
            rows={2}
            maxLength={2000}
            disabled={busy}
          />
          <Button type="submit" variant="primary" icon={Send} busy={busy} disabled={!input.trim()}>
            Send
          </Button>
        </form>
      </div>
    </Panel>
  )
}

function AssistantMessage({
  runId,
  answer,
  canApprove,
  onRevised,
}: {
  runId: string
  answer: Answer
  canApprove: boolean
  onRevised?: () => void
}) {
  return (
    <div className="rasst__msg rasst__msg--assistant">
      <p className="rasst__reply">{answer.reply}</p>

      {answer.citations.length > 0 && (
        <div className="rasst__cites">
          <span className="eyebrow">From the audit</span>
          {answer.citations.map((c) => (
            <Chip key={c} tone="neutral">
              {c}
            </Chip>
          ))}
        </div>
      )}

      {answer.warnings.map((w) => (
        <p key={w} className="rasst__warn">
          <AlertTriangle size={13} aria-hidden="true" /> {w}
        </p>
      ))}

      {answer.drafts.map((d, i) => (
        <DraftCard key={i} draft={d} />
      ))}

      {answer.proposedEdit && (
        <ProposedEditCard runId={runId} proposal={answer.proposedEdit} canApprove={canApprove} onRevised={onRevised} />
      )}
    </div>
  )
}

function DraftCard({ draft }: { draft: Draft }) {
  const [copied, setCopied] = useState(false)
  const flagged = draft.ungroundedFigures.length > 0 || draft.claimViolations.length > 0
  return (
    <div className={`rasst__draft${flagged ? ' is-flagged' : ''}`}>
      <div className="rasst__drafthead">
        <span className="eyebrow">Draft · {draft.kind.replace(/_/g, ' ')}</span>
        <strong>{draft.title}</strong>
        <Button
          size="sm"
          icon={copied ? Check : Copy}
          onClick={() => {
            void navigator.clipboard?.writeText(draft.content).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="rasst__draftbody">{draft.content}</pre>
      {draft.ungroundedFigures.length > 0 && (
        <p className="rasst__warn">
          <AlertTriangle size={13} aria-hidden="true" /> Contains figures the audit does not contain:{' '}
          {draft.ungroundedFigures.map((f) => `"${f}"`).join(', ')}. Check them before using this draft.
        </p>
      )}
      {draft.claimViolations.map((v) => (
        <p key={v.pattern + v.match} className="rasst__warn">
          <AlertTriangle size={13} aria-hidden="true" /> [{v.pattern}] “{v.match}” — {v.why}
        </p>
      ))}
    </div>
  )
}

function ProposedEditCard({
  runId,
  proposal,
  canApprove,
  onRevised,
}: {
  runId: string
  proposal: ProposedEdit
  canApprove: boolean
  onRevised?: () => void
}) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [message, setMessage] = useState<string | null>(null)

  const save = async () => {
    setState('saving')
    setMessage(null)
    try {
      // Fresh concurrency token, read at the moment of saving: the report may
      // have been revised since this answer was produced.
      const approval = await api.get<ApprovalSnapshot>(`/website-audit/runs/${runId}/approval`)
      if (!approval.canEdit) {
        throw new Error('This report cannot be edited in its current state. Reopen it for review first.')
      }
      const result = await api.post<{ revisionNumber: number; approvable: boolean; note: string }>(
        `/website-audit/runs/${runId}/report/revise`,
        {
          edit: proposal.edit,
          changeReason: `Audit assistant: ${proposal.changeReason}`,
          expectedLockVersion: approval.lockVersion,
          expectedRevision: approval.currentRevision,
        },
      )
      setState('saved')
      setMessage(`Saved as revision ${result.revisionNumber}. ${result.note}`)
      onRevised?.()
    } catch (err) {
      setState('error')
      setMessage((err as Error).message)
    }
  }

  return (
    <div className={`rasst__edit${proposal.blocked ? ' is-blocked' : ''}`}>
      <div className="rasst__drafthead">
        <span className="eyebrow">Proposed report change</span>
        <strong>{proposal.changeReason}</strong>
      </div>

      {Object.entries(proposal.edit).map(([field, next]) => (
        <div key={field} className="rasst__diff">
          <span className="rasst__difffield">{FIELD_LABEL[field] ?? field}</span>
          <div className="rasst__diffcols">
            <div className="rasst__diffold">
              <span className="eyebrow">Now</span>
              <p>{proposal.current[field as keyof ProposedEdit['current']] || '—'}</p>
            </div>
            <div className="rasst__diffnew">
              <span className="eyebrow">Proposed</span>
              <p>{next}</p>
            </div>
          </div>
        </div>
      ))}

      {proposal.blocked ? (
        <div className="rasst__blocked">
          <p className="rasst__warn">
            <AlertTriangle size={13} aria-hidden="true" /> This change cannot be saved as proposed:
          </p>
          <ul>
            {proposal.blockedReasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ) : canApprove ? (
        <div className="rasst__editactions">
          <Button
            variant="primary"
            icon={FileEdit}
            busy={state === 'saving'}
            disabled={state === 'saved'}
            onClick={() => void save()}
          >
            {state === 'saved' ? 'Saved as a new revision' : 'Save as a new revision for review'}
          </Button>
          <span className="rasst__note">Creates a new revision; the report still needs approval.</span>
        </div>
      ) : (
        <p className="rasst__note">Saving report changes needs the approve permission.</p>
      )}

      {message && <p className={state === 'error' ? 'rasst__warn' : 'rasst__ok'}>{message}</p>}
    </div>
  )
}
