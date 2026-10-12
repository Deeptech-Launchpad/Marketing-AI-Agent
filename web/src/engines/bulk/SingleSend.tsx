import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Send } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Panel } from '../../components/ui/primitives'
import { useBulkCall as useCall } from './useBulkCall'
import { safeHtml } from './SignatureEditor'
import { AttachmentsField, attachmentList, type BulkAttachment } from './AttachmentsField'

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
  attachments?: BulkAttachment[]
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
  // Files that go with the email, uploaded below the preview (2026-10-12).
  const [attachments, setAttachments] = useState<BulkAttachment[]>([])
  const [uploading, setUploading] = useState(false)
  // The review that follows a change of files runs on its own (so no click can be dropped by the busy guard),
  // and only the LATEST answer is used: an older answer arriving late is ignored.
  const [reviewing, setReviewing] = useState(false)
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const latest = useRef(0)
  const call = useCall(() => undefined)

  const body = () => ({
    firstName: firstName.trim(),
    companyName: companyName.trim(),
    toEmail: toEmail.trim(),
    ccEmails: splitEmails(cc),
    templateKey,
    ...(attachments.length ? { attachmentIds: attachments.map((a) => a.id) } : {}),
  })
  // Any change means the email must be reviewed again.
  const changed = <T,>(set: (v: T) => void) => (v: T) => {
    latest.current += 1
    setReviewing(false)
    set(v)
    setReview(null)
    setConfirmed(false)
  }
  const doReview = () => {
    latest.current += 1
    setReviewing(false)
    setRefreshError(null)
    void call.run('review', async () => {
      setReview((await api.post('/outreach/bulk/single/review', body())) as SingleReview)
    })
  }
  const send = () =>
    void call.run('send', async () => {
      const r = (await api.post('/outreach/bulk/single/start', { ...body(), confirm: confirmed })) as { campaignId: string }
      onStarted(r.campaignId)
    })

  // Changing the files means the email is reviewed again (and approved again).
  useEffect(() => {
    if (!review) return
    setConfirmed(false)
    setRefreshError(null)
    setReviewing(true)
    const mine = ++latest.current
    api
      .post('/outreach/bulk/single/review', body())
      .then((r) => {
        if (latest.current === mine) setReview(r as SingleReview)
      })
      .catch((err) => {
        if (latest.current === mine) setRefreshError((err as Error)?.message || 'The email could not be reviewed again.')
      })
      .finally(() => {
        if (latest.current === mine) setReviewing(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachments])

  const ready = firstName.trim() && companyName.trim() && toEmail.trim()
  const canSend = review && !review.blocked && !review.sending.reason && review.sender.authorized && confirmed && canApprove && !uploading && !reviewing

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
      {(call.error || refreshError) && (
        <p className="otr-err" role="alert">
          {call.error ?? refreshError}
        </p>
      )}
      {reviewing && <p className="note">Checking the email again with the files…</p>}
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
            {review.attachments && review.attachments.length > 0 && <p className="cell-dim">Attachments: {attachmentList(review.attachments)}</p>}
            <p>
              <Chip tone="info">Version {review.version}</Chip> <span className="field-label">Subject</span> {review.subject}
            </p>
            <div className="bulk-email-html" dangerouslySetInnerHTML={{ __html: safeHtml(review.html) }} />
          </article>
          <AttachmentsField value={attachments} onChange={setAttachments} onBusyChange={setUploading} />
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
