import { useState } from 'react'
import { ArrowLeft, Send } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Panel } from '../../components/ui/primitives'
import { useBulkCall as useCall } from './useBulkCall'
import { safeHtml } from './SignatureEditor'

// SEND TO ONE PERSON (2026-10-08): the same approved Version 1, 2 or 3, sender
// and checks as a bulk list — without an Excel file. Type the person in,
// review the email exactly as it will be sent, approve, and it goes within a
// minute.

interface SingleReview {
  toEmail: string
  ccEmails: string[]
  version: number | null
  subject: string
  text: string
  html: string
  blocked: string | null
  previouslySentLocal: string | null
  sender: { fromEmail: string | null; authorized: boolean; problem: string | null }
  sending: { reason: string | null }
}

const VERSIONS = [
  { key: 'static_site_v1', label: 'Version 1' },
  { key: 'static_site_v2', label: 'Version 2' },
  { key: 'static_site_v3', label: 'Version 3' },
]

const splitEmails = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

export function SingleSend({ canApprove, onCancel, onStarted }: { canApprove: boolean; onCancel: () => void; onStarted: (id: string) => void }) {
  const [firstName, setFirstName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [toEmail, setToEmail] = useState('')
  const [cc, setCc] = useState('')
  const [templateKey, setTemplateKey] = useState(VERSIONS[0]!.key)
  const [review, setReview] = useState<SingleReview | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const call = useCall(() => undefined)

  const body = () => ({ firstName: firstName.trim(), companyName: companyName.trim(), toEmail: toEmail.trim(), ccEmails: splitEmails(cc), templateKey })
  // Any change means the email must be reviewed again.
  const changed = <T,>(set: (v: T) => void) => (v: T) => {
    set(v)
    setReview(null)
    setConfirmed(false)
  }
  const doReview = () =>
    void call.run('review', async () => {
      setReview((await api.post('/outreach/bulk/single/review', body())) as SingleReview)
    })
  const send = () =>
    void call.run('send', async () => {
      const r = (await api.post('/outreach/bulk/single/start', { ...body(), confirm: confirmed })) as { campaignId: string }
      onStarted(r.campaignId)
    })

  const ready = firstName.trim() && companyName.trim() && toEmail.trim()
  const canSend = review && !review.blocked && !review.sending.reason && review.sender.authorized && confirmed && canApprove

  return (
    <Panel
      title="Send to one person"
      subtitle="An approved email to one person — no Excel file. Only [First Name] and [Company Name] are filled in."
      actions={
        <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onCancel}>
          Back
        </Button>
      }
    >
      <div className="otr-grid">
        <label>
          <span className="field-label">First name</span>
          <input className="otr-input" aria-label="First name" value={firstName} onChange={(e) => changed(setFirstName)(e.target.value)} />
        </label>
        <label>
          <span className="field-label">Company name</span>
          <input className="otr-input" aria-label="Company name" value={companyName} onChange={(e) => changed(setCompanyName)(e.target.value)} />
        </label>
        <label>
          <span className="field-label">Email</span>
          <input className="otr-input" type="email" aria-label="Email" value={toEmail} onChange={(e) => changed(setToEmail)(e.target.value)} />
        </label>
        <label>
          <span className="field-label">CC (optional)</span>
          <input className="otr-input" aria-label="CC" value={cc} onChange={(e) => changed(setCc)(e.target.value)} />
        </label>
        <label>
          <span className="field-label">Approved email</span>
          <select className="otr-input" aria-label="Approved email" value={templateKey} onChange={(e) => changed(setTemplateKey)(e.target.value)}>
            {VERSIONS.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      {!review ? (
        <div className="row" style={{ marginTop: 'var(--s3)' }}>
          <Button variant="primary" disabled={!ready} busy={call.busy === 'review'} onClick={doReview}>
            Review the email
          </Button>
        </div>
      ) : (
        <>
          <article className="bulk-email" aria-label="Email preview">
            <p className="cell-dim">
              From: {review.sender.fromEmail ?? 'not set'} · To: {review.toEmail}
              {review.ccEmails.length ? ` · CC: ${review.ccEmails.join(', ')}` : ''}
            </p>
            <p>
              <Chip tone="info">Version {review.version}</Chip> <span className="field-label">Subject</span> {review.subject}
            </p>
            <div className="bulk-email-html" dangerouslySetInnerHTML={{ __html: safeHtml(review.html) }} />
          </article>
          {review.previouslySentLocal && <p className="note">This address was last emailed on {review.previouslySentLocal}.</p>}
          {review.blocked && <p className="otr-warn">{review.blocked}</p>}
          {review.sending.reason && <p className="otr-warn">{review.sending.reason}</p>}
          {!review.sending.reason && review.sender.problem && <p className="otr-warn">{review.sender.problem}</p>}
          {!canApprove && <p className="note">Sending needs an approver or an administrator.</p>}
          {!review.blocked && (
            <label className="otr-check">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              <span>I reviewed this email and approve sending it now.</span>
            </label>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button variant="primary" icon={Send} disabled={!canSend} busy={call.busy === 'send'} onClick={send}>
              Approve and send
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}
