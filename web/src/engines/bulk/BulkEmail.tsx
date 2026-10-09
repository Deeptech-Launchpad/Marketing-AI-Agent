import { useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, FileSpreadsheet, Mail, Pause, Play, Plus, RefreshCw, Send, Square, User, UserX } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync, usePolling } from '../../lib/hooks'
import { Button, Chip, Panel, Unset } from '../../components/ui/primitives'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states'
import { useBulkCall as useCall } from './useBulkCall'
import { SignatureEditor, SignatureView, safeHtml, textToHtml } from './SignatureEditor'
import { SingleSend } from './SingleSend'
import './bulk.css'

// BULK EMAIL (2026-10-08) — simple and standalone:
//
//   Upload Excel → analyze contacts → review emails → date, time and minutes
//   between emails (IST) → approve → start sending
//
// The email is the approved template only, with [First Name] and [Company
// Name] filled from the Excel file, and the sender's signature under it. The
// platform sends the emails one after another: email 1 at the start time, then
// one every N minutes, until the list is done. It shares no code with One
// company or Several companies.
//
// The Sender (From, CC, signature) is set here. The From is what customers
// see; it is only used once the server has checked that its SMTP account may
// genuinely send as it.

interface SendingStatus {
  enabled: boolean
  mailboxConfigured: boolean
  account: { email: string; source: 'bulk' | 'system' } | null
  reason: string | null
}
interface SenderView {
  /** 'crm' = sent through NXT Sales, as its configured Gmail sender. */
  via?: 'smtp' | 'crm'
  senderName?: string | null
  fromEmail: string | null
  ccEmails: string[]
  signature: string
  signatureHtml?: string
  signatureRemoved?: string[]
  check: { authorized: boolean; reason: string; warning: string | null; checkedLocal: string } | null
  authorized: boolean
  problem: string | null
  account: { email: string; source: 'bulk' | 'system' } | null
}
const isSenderView = (v: unknown): v is SenderView => Boolean(v && typeof v === 'object' && 'authorized' in v && 'ccEmails' in v)
interface Settings {
  sending: SendingStatus
  templates: Array<{ key: string; label: string; subject: string; body: string; placeholders: string[] }>
}
interface Analysis {
  fileName: string | null
  totalRows: number
  columns: { company: string | null; status: string | null; contacts: Array<{ name: string | null; title: string | null; email: string }> }
  companies: Array<{ key: string; companyName: string; rows: number[]; people: Array<{ name: string | null; email: string }>; skip: string | null }>
  noAddress: Array<{ row: number; companyName: string; reason: string }>
}
interface ReviewRow {
  position: number
  companyName: string
  contactName: string | null
  toEmail: string | null
  ccEmails: string[]
  rows: number[]
  subject: string | null
  text: string | null
  html?: string | null
  /** The approved version this person receives (1, 2 or 3). */
  version?: number | null
  status: 'ready' | 'skipped'
  reason: string | null
  scheduledLocal: string | null
}
interface Review {
  counts: { rowsWithCompany: number; companies: number; validEmails: number; skipped: number; noWorkAddress: number }
  rows: ReviewRow[]
  noAddress: Array<{ row: number; companyName: string; reason: string }>
  schedule: { firstLocal: string | null; estimatedCompletionLocal: string | null; intervalMinutes: number }
  sender: SenderView
  sending: SendingStatus
}
interface CampaignRow {
  id: string
  name: string
  status: string
  statusReason?: string | null
  fromEmail: string
  startLocal: string
  intervalMinutes: number
  createdAt: string
  completedLocal: string | null
  estimatedCompletionLocal?: string | null
  counts?: { scheduled: number; sending: number; sent: number; failed: number; skipped: number; total: number; opens?: OpenCounts }
}
interface RecipientRow {
  id: string
  companyName: string
  contactName: string | null
  toEmail: string | null
  ccEmails: string[]
  subject: string | null
  body: string | null
  status: string
  reason: string | null
  scheduledLocal: string | null
  sentLocal: string | null
  version?: number | null
  tracking?: OpenTracking | null
}

// Email open tracking (2026-10-09). An "open" is the email's invisible image
// being loaded — a signal, not proof that a person read it.
interface OpenCounts {
  sent: number
  openDetected: number
  noOpenDetected: number
  trackingUnavailable: number
}
interface OpenTracking {
  status: 'open_detected' | 'no_open_detected' | 'tracking_unavailable'
  note: string | null
  openCount: number
  firstOpenedLocal: string | null
  lastOpenedLocal: string | null
}
interface TrackingSetting {
  enabled: boolean
  reason: string | null
  via?: 'smtp' | 'crm'
}
const OPEN_STATUS: Record<OpenTracking['status'], { word: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  open_detected: { word: 'Open detected', tone: 'ok' },
  no_open_detected: { word: 'No open detected', tone: 'neutral' },
  tracking_unavailable: { word: 'Tracking unavailable', tone: 'warn' },
}
const OPEN_MEANING =
  'An open is detected when the email’s invisible image is loaded. Some mail programs block images, and some privacy features and security scanners load them without anyone reading — so it is a signal, not proof of reading or of interest.'

/** Whether open tracking is on for new emails, and what it needs. */
function TrackingNotice({ setting }: { setting: TrackingSetting | null | undefined }) {
  if (!setting) return null
  if (setting.via === 'crm') {
    return (
      <p className="note">
        Emails are sent through NXT Sales, which tracks opens with its own tracking; the results appear here within a few minutes. {OPEN_MEANING}
      </p>
    )
  }
  return setting.enabled ? (
    <p className="note">Open tracking is on for new emails. {OPEN_MEANING}</p>
  ) : (
    <p className="note">
      Open tracking is off: {setting.reason} New emails are sent without it and show &ldquo;Tracking unavailable&rdquo;. Before it is switched on, the privacy policy
      / consent wording should be reviewed — recipients are not told that opens are recorded.
    </p>
  )
}

const CAMPAIGN_STATUS: Record<string, { word: string; tone: 'ok' | 'warn' | 'info' | 'neutral' }> = {
  running: { word: 'Sending', tone: 'info' },
  paused: { word: 'Paused', tone: 'warn' },
  completed: { word: 'Completed', tone: 'ok' },
  cancelled: { word: 'Cancelled', tone: 'neutral' },
}
const RECIPIENT_STATUS: Record<string, { word: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent' }> = {
  scheduled: { word: 'Scheduled', tone: 'info' },
  sending: { word: 'Sending', tone: 'accent' },
  sent: { word: 'Sent', tone: 'ok' },
  failed: { word: 'Failed', tone: 'danger' },
  skipped: { word: 'Skipped', tone: 'neutral' },
}

/** "10:00" → "10:00 AM". */
function ampm(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return hhmm
  const h = Number(m[1])
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

/** Today's date in India, as YYYY-MM-DD. */
function todayIst(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(new Error('The file could not be read.'))
    r.readAsDataURL(file)
  })
}

export function BulkEmail({ canOperate, canApprove }: { canOperate: boolean; canApprove: boolean }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [single, setSingle] = useState(false)
  if (single) {
    return (
      <SingleSend
        canApprove={canApprove}
        onCancel={() => setSingle(false)}
        onStarted={(id) => {
          setSingle(false)
          setOpenId(id)
        }}
      />
    )
  }
  if (creating) {
    return (
      <NewBulk
        canApprove={canApprove}
        onCancel={() => setCreating(false)}
        onStarted={(id) => {
          setCreating(false)
          setOpenId(id)
        }}
      />
    )
  }
  if (openId) return <BulkDetail id={openId} canOperate={canOperate} onBack={() => setOpenId(null)} />
  return (
    <>
      <SenderPanel canApprove={canApprove} />
      <BulkList canOperate={canOperate} onOpen={setOpenId} onNew={() => setCreating(true)} onSingle={() => setSingle(true)} />
    </>
  )
}

/** "a@x.com, b@x.com" → ["a@x.com", "b@x.com"]. */
const splitEmails = (s: string) =>
  s
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean)

function SenderStatus({ sender }: { sender: SenderView }) {
  if (!sender.fromEmail) return <Chip tone="warn">Not set</Chip>
  if (sender.authorized) return <Chip tone="ok">Authorized</Chip>
  if (!sender.check) return <Chip tone="warn">Not checked</Chip>
  return <Chip tone="danger">Not authorized</Chip>
}

/** The From the customer sees, CC on every email, the signature — and whether the server may send as that From. */
function SenderPanel({ canApprove }: { canApprove: boolean }) {
  const state = useAsync<unknown>((signal) => api.get('/outreach/bulk/sender', { signal }), [])
  const [saved, setSaved] = useState<SenderView | null>(null)
  const sender = saved ?? (isSenderView(state.data) ? state.data : null)
  const call = useCall(() => undefined)
  const [editing, setEditing] = useState(false)
  const [from, setFrom] = useState('')
  const [cc, setCc] = useState('')
  const [signatureHtml, setSignatureHtml] = useState('')

  const edit = () => {
    setFrom(sender?.fromEmail ?? '')
    setCc(sender?.ccEmails.join(', ') ?? '')
    setSignatureHtml(sender?.signatureHtml || textToHtml(sender?.signature ?? ''))
    setEditing(true)
  }
  const save = () =>
    void call.run('save', async () => {
      const viaCrm = sender?.via === 'crm'
      const r = await api.post('/outreach/bulk/sender', viaCrm ? { ccEmails: splitEmails(cc) } : { fromEmail: from.trim(), ccEmails: splitEmails(cc), signatureHtml })
      if (isSenderView(r)) setSaved(r)
      setEditing(false)
    })
  const recheck = () =>
    void call.run('check', async () => {
      const r = await api.post('/outreach/bulk/sender/check', {})
      if (isSenderView(r)) setSaved(r)
    })

  return (
    <Panel
      title="Sender"
      subtitle="The From address customers see, CC on every email, and your signature."
      actions={
        canApprove &&
        sender &&
        !editing && (
          <div className="row">
            {sender.fromEmail && (
              <Button size="sm" variant="quiet" icon={RefreshCw} busy={call.busy === 'check'} onClick={recheck}>
                Check sender
              </Button>
            )}
            <Button size="sm" icon={Mail} onClick={edit}>
              {sender.via === 'crm' ? 'Edit CC' : sender.fromEmail ? 'Edit sender' : 'Set sender'}
            </Button>
          </div>
        )
      }
    >
      {state.loading && !sender ? (
        <Unset what="Loading…" />
      ) : state.error && !sender ? (
        <ErrorState error={state.error} what="The sender could not be read" onRetry={state.refresh} />
      ) : !sender ? null : editing ? (
        <>
          <div className="otr-grid">
            {sender.via !== 'crm' && (
              <label>
                <span className="field-label">From email</span>
                <input className="otr-input" type="email" aria-label="From email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="sales@yourcompany.com" />
              </label>
            )}
            <label>
              <span className="field-label">CC on every email (optional)</span>
              <input className="otr-input" aria-label="CC emails" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="colleague@yourcompany.com" />
            </label>
          </div>
          {sender.via === 'crm' ? (
            <p className="note">The From address and the signature are NXT Sales&rsquo; own: its configured Gmail sender, and that Gmail account&rsquo;s signature.</p>
          ) : (
            <>
              <label style={{ display: 'block', marginTop: 'var(--s2)' }}>
                <span className="field-label">Signature (optional) — paste it from your email; it is used exactly as it looks here</span>
              </label>
              <SignatureEditor initialHtml={signatureHtml} onChange={setSignatureHtml} />
              <p className="note">
                Saving checks that the server&rsquo;s sending account may genuinely send as this From address. For a Gmail account, one check message is sent to that
                account itself — never to a customer. This can take up to 30 seconds.
              </p>
            </>
          )}
          {call.error && (
            <p className="otr-err" role="alert">
              {call.error}
            </p>
          )}
          <div className="row">
            <Button variant="quiet" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={sender.via !== 'crm' && !from.trim()} busy={call.busy === 'save'} onClick={save}>
              {sender.via === 'crm' ? 'Save' : 'Save and check sender'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <ul className="otr-list">
            <li>
              <span className="field-label">From</span> {sender.fromEmail ?? <span className="cell-dim">not set</span>} <SenderStatus sender={sender} />
              {sender.via === 'crm' && <div className="cell-dim">Sent through NXT Sales, from its configured Gmail sender{sender.senderName ? ` (${sender.senderName})` : ''}.</div>}
            </li>
            <li>
              <span className="field-label">CC</span> {sender.ccEmails.length ? sender.ccEmails.join(', ') : <span className="cell-dim">none</span>}
            </li>
            <li>
              <span className="field-label">Signature</span>{' '}
              {sender.via === 'crm' ? (
                <span className="cell-dim">The Gmail account&rsquo;s own signature, added by NXT Sales.</span>
              ) : sender.signatureHtml || sender.signature ? (
                <SignatureView html={sender.signatureHtml || textToHtml(sender.signature)} />
              ) : (
                <span className="cell-dim">none</span>
              )}
            </li>
          </ul>
          {sender.signatureRemoved && sender.signatureRemoved.length > 0 && (
            <p className="note">Taken out of the pasted signature, because it cannot be sent safely in an email: {sender.signatureRemoved.join('; ')}.</p>
          )}
          {sender.problem && <p className="otr-warn">{sender.problem}</p>}
          {sender.authorized && sender.check && (
            <p className="cell-dim">
              {sender.check.reason} Checked {sender.check.checkedLocal}.{sender.check.warning ? ` ${sender.check.warning}` : ''}
            </p>
          )}
          {sender.account && (
            <p className="cell-dim">
              Carried by the server&rsquo;s SMTP account {sender.account.email}
              {sender.account.source === 'system' ? ' (the system account)' : ''} — customers see only the From above.
            </p>
          )}
          {call.error && (
            <p className="otr-err" role="alert">
              {call.error}
            </p>
          )}
        </>
      )}
    </Panel>
  )
}

function SendingNote({ sending }: { sending: SendingStatus | null }) {
  if (!sending || !sending.reason) return null
  return <p className="otr-warn">{sending.reason}</p>
}

function BulkList({ canOperate, onOpen, onNew, onSingle }: { canOperate: boolean; onOpen: (id: string) => void; onNew: () => void; onSingle: () => void }) {
  const list = useAsync<unknown>((signal) => api.get('/outreach/bulk', { signal }), [])
  const data = list.data as { campaigns?: CampaignRow[]; sending?: SendingStatus; openTracking?: TrackingSetting } | null
  const rows = Array.isArray(data?.campaigns) ? data!.campaigns : []
  usePolling(list.refresh, rows.some((r) => r.status === 'running'), 60_000)
  return (
    <Panel
      title="Bulk email"
      subtitle="Upload an Excel list, review the emails, choose when to start — they go one after another."
      actions={
        canOperate && (
          <div className="row">
            <Button size="sm" icon={User} onClick={onSingle}>
              Send to one person
            </Button>
            <Button size="sm" variant="primary" icon={Plus} onClick={onNew}>
              New bulk email
            </Button>
          </div>
        )
      }
    >
      <TrackingNotice setting={data?.openTracking} />
      {list.loading && !list.data ? (
        <Unset what="Loading…" />
      ) : list.error ? (
        <ErrorState error={list.error} what="The bulk emails could not be read" onRetry={list.refresh} />
      ) : rows.length === 0 ? (
        <EmptyState title="No bulk email yet" detail="Click New bulk email and upload the Excel list of contacts." />
      ) : (
        <table className="otr-table">
          <thead>
            <tr>
              <th>Bulk email</th>
              <th>Status</th>
              <th>Sent</th>
              <th>Scheduled</th>
              <th>Failed</th>
              <th>Skipped</th>
              <th>Open detected</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  <div className="cell-dim">
                    From {c.fromEmail} · started {c.startLocal}
                  </div>
                </td>
                <td>
                  <Chip tone={CAMPAIGN_STATUS[c.status]?.tone ?? 'neutral'}>{CAMPAIGN_STATUS[c.status]?.word ?? c.status}</Chip>
                  {c.completedLocal && <div className="cell-dim">{c.completedLocal}</div>}
                  {c.status === 'paused' && c.statusReason && <div className="cell-dim">Not authorized — see the send</div>}
                </td>
                <td className="tnum">{c.counts?.sent ?? 0}</td>
                <td className="tnum">{c.counts?.scheduled ?? 0}</td>
                <td className="tnum">{c.counts?.failed ?? 0}</td>
                <td className="tnum">{c.counts?.skipped ?? 0}</td>
                <td className="tnum">
                  {!c.counts?.opens || c.counts.opens.sent === 0 ? (
                    '—'
                  ) : c.counts.opens.trackingUnavailable === c.counts.opens.sent ? (
                    <span className="cell-dim">Tracking unavailable</span>
                  ) : (
                    `${c.counts.opens.openDetected} of ${c.counts.opens.sent - c.counts.opens.trackingUnavailable} tracked`
                  )}
                </td>
                <td>
                  <Button size="sm" onClick={() => onOpen(c.id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  )
}

type Step = 'upload' | 'review' | 'schedule'
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'upload', label: '1. Upload Excel' },
  { key: 'review', label: '2. Review emails' },
  { key: 'schedule', label: '3. Date, time and start' },
]

function NewBulk({ canApprove, onCancel, onStarted }: { canApprove: boolean; onCancel: () => void; onStarted: (id: string) => void }) {
  const settingsState = useAsync<unknown>((signal) => api.get('/outreach/bulk/settings', { signal }), [])
  const settings = settingsState.data as Settings | null
  const template = settings?.templates[0] ?? null

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null)
  // Test option (off by default): also use webmail addresses, for a first run
  // with the team's own gmail / yahoo addresses.
  const [allowWebmail, setAllowWebmail] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [startDate, setStartDate] = useState(todayIst())
  const [startTime, setStartTime] = useState('10:00')
  const [interval, setIntervalMinutes] = useState('5')
  const [review, setReview] = useState<Review | null>(null)
  const [previewPos, setPreviewPos] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const call = useCall(() => undefined)
  const fileInput = useRef<HTMLInputElement>(null)

  const readFile = async (picked: { name: string; base64: string }, webmail: boolean) => {
    setAnalysis(null)
    setReview(null)
    const r = (await api.post('/outreach/bulk/analyze', { fileBase64: picked.base64, fileName: picked.name, allowWebmail: webmail })) as Analysis
    setAnalysis(r)
  }
  const analyze = (picked: { name: string; base64: string }, webmail: boolean) => void call.run('upload', () => readFile(picked, webmail))
  const upload = (f: File | undefined) => {
    if (!f) return
    void call.run('upload', async () => {
      const picked = { name: f.name, base64: await readAsBase64(f) }
      setFile(picked)
      await readFile(picked, allowWebmail)
    })
  }

  const body = () => ({
    fileBase64: file!.base64,
    fileName: file!.name,
    allowWebmail,
    templateKey: template?.key ?? 'static_site_v1',
    startDate,
    startTime,
    intervalMinutes: Number(interval),
  })
  const loadReview = () =>
    void call.run('review', async () => {
      const r = (await api.post('/outreach/bulk/review', body())) as Review
      setReview(r)
      setPreviewPos(r.rows.find((x) => x.status === 'ready')?.position ?? null)
    })
  const start = () =>
    void call.run('start', async () => {
      const r = (await api.post('/outreach/bulk/start', { ...body(), confirm: confirmed })) as { campaignId: string }
      onStarted(r.campaignId)
    })

  const sendable = analysis ? analysis.companies.filter((c) => !c.skip && c.people.length > 0) : []
  const preview = review?.rows.find((r) => r.position === previewPos) ?? null
  const intervalOk = /^\d+$/.test(interval) && Number(interval) >= 1 && Number(interval) <= 240

  return (
    <Panel
      title="New bulk email"
      subtitle={template ? 'Approved emails Version 1, 2 and 3, given in turn down the list — only [First Name] and [Company Name] filled in' : undefined}
      actions={
        <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onCancel}>
          Back
        </Button>
      }
    >
      <ol className="bulk-steps" aria-label="Steps">
        {STEPS.map((s) => (
          <li key={s.key} className={s.key === step ? 'is-current' : undefined} aria-current={s.key === step ? 'step' : undefined}>
            {s.label}
          </li>
        ))}
      </ol>
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}

      {step === 'upload' && (
        <>
          <p className="note">
            Upload the Excel file (.xlsx). Each company gets one email: the first named person receives it, colleagues from the same company are copied.
          </p>
          <div className="row">
            <input
              ref={fileInput}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label="Excel file"
              onChange={(e) => upload(e.target.files?.[0])}
              style={{ display: 'none' }}
            />
            <Button icon={FileSpreadsheet} busy={call.busy === 'upload'} onClick={() => fileInput.current?.click()}>
              {file ? 'Choose another file' : 'Choose Excel file'}
            </Button>
            {file && <span className="cell-dim">{file.name}</span>}
          </div>
          <label className="bulk-test">
            <input
              type="checkbox"
              checked={allowWebmail}
              onChange={(e) => {
                setAllowWebmail(e.target.checked)
                if (file) analyze(file, e.target.checked)
              }}
            />
            <span>
              Include personal / webmail addresses (gmail, yahoo …) — <strong>for a test with your own team&rsquo;s addresses</strong>. Leave this off for a
              real customer list: only work addresses are used.
            </span>
          </label>
          {analysis && (
            <>
              <ul className="otr-list">
                <li>
                  <strong>{sendable.length}</strong> companies with a valid email address · {analysis.companies.filter((c) => c.skip).length} skipped by Status ·{' '}
                  {analysis.noAddress.length} rows with no usable address ({analysis.totalRows} rows in the file)
                </li>
              </ul>
              <div className="otr-scroll" style={{ maxHeight: 320, overflowY: 'auto' }}>
                <table className="otr-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>To</th>
                      <th>CC</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.companies
                      .filter((c) => c.people.length > 0 || c.skip)
                      .map((c) => (
                        <tr key={c.key}>
                          <td>{c.companyName}</td>
                          <td>
                            {c.people[0] ? (
                              <>
                                {c.people[0].name ?? <span className="cell-dim">no name</span>}
                                <div className="cell-dim">{c.people[0].email}</div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="cell-dim">{c.people.slice(1).map((p) => p.email).join(', ') || '—'}</td>
                          <td>{c.skip ? <Chip tone="neutral">Skipped — {c.skip}</Chip> : null}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button
              variant="primary"
              disabled={!analysis || sendable.length === 0}
              busy={call.busy === 'review'}
              onClick={() => {
                setConfirmed(false)
                setStep('review')
                loadReview()
              }}
            >
              Next: review emails
            </Button>
          </div>
        </>
      )}

      {step === 'review' && (
        <>
          {!review ? (
            <LoadingState what="Preparing every email" />
          ) : (
            <>
              <p className="note">
                <strong>{review.counts.validEmails} emails</strong> will be sent · {review.counts.skipped} skipped · {review.counts.noWorkAddress} rows with no usable address. Click Preview to read
                any email exactly as it will be sent.
              </p>
              <div className="otr-scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="otr-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Person</th>
                      <th>Version</th>
                      <th>To</th>
                      <th>CC</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {review.rows.map((r) => (
                      <tr key={r.position} aria-selected={r.position === previewPos}>
                        <td>{r.companyName}</td>
                        <td>{r.contactName ?? '—'}</td>
                        <td>{r.version ? `Version ${r.version}` : '—'}</td>
                        <td>{r.toEmail ?? '—'}</td>
                        <td className="cell-dim">{r.ccEmails.join(', ') || '—'}</td>
                        <td>
                          {r.status === 'ready' ? (
                            <Button size="sm" variant="quiet" onClick={() => setPreviewPos(r.position)}>
                              Preview
                            </Button>
                          ) : (
                            <span className="cell-dim">Skipped — {r.reason}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {preview && (
                <article className="bulk-email" aria-label="Email preview">
                  <p className="cell-dim">
                    To: {preview.toEmail}
                    {preview.ccEmails.length ? ` · CC: ${preview.ccEmails.join(', ')}` : ''}
                  </p>
                  <p>
                    {preview.version && <Chip tone="info">Version {preview.version}</Chip>} <span className="field-label">Subject</span> {preview.subject}
                  </p>
                  {preview.html ? (
                    <div className="bulk-email-html" dangerouslySetInnerHTML={{ __html: safeHtml(preview.html) }} />
                  ) : (
                    <pre className="bulk-body">{preview.text}</pre>
                  )}
                </article>
              )}
            </>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button variant="quiet" onClick={() => setStep('upload')}>
              Back
            </Button>
            <Button variant="primary" disabled={!review || review.counts.validEmails === 0} onClick={() => setStep('schedule')}>
              Next: date and time
            </Button>
          </div>
        </>
      )}

      {step === 'schedule' && (
        <>
          <div className="otr-grid">
            <label>
              <span className="field-label">Date</span>
              <input
                className="otr-input"
                type="date"
                value={startDate}
                onChange={(e) => {
                  setStartDate(e.target.value)
                  setReview(null)
                }}
              />
            </label>
            <label>
              <span className="field-label">Time, IST ({ampm(startTime)})</span>
              <input
                className="otr-input"
                type="time"
                value={startTime}
                onChange={(e) => {
                  setStartTime(e.target.value)
                  setReview(null)
                }}
              />
            </label>
            <label>
              <span className="field-label">Minutes between emails</span>
              <input
                className="otr-input"
                type="number"
                min={1}
                max={240}
                value={interval}
                onChange={(e) => {
                  setIntervalMinutes(e.target.value)
                  setReview(null)
                }}
              />
            </label>
          </div>
          {!review ? (
            <div className="row" style={{ marginTop: 'var(--s3)' }}>
              <Button
                variant="quiet"
                onClick={() => {
                  setStep('review')
                  loadReview()
                }}
              >
                Back
              </Button>
              <Button variant="primary" disabled={!startDate || !startTime || !intervalOk} busy={call.busy === 'review'} onClick={loadReview}>
                Show the sending times
              </Button>
            </div>
          ) : (
            <>
              <ul className="otr-list">
                <li>
                  <strong>{review.counts.validEmails} emails</strong>, one every {review.schedule.intervalMinutes} minutes, from <strong>{review.schedule.firstLocal ?? '—'}</strong> until{' '}
                  <strong>{review.schedule.estimatedCompletionLocal ?? '—'}</strong>.
                </li>
                <li>
                  From: {review.sender.fromEmail ?? 'not set'} <SenderStatus sender={review.sender} />
                  {review.sender.ccEmails.length > 0 && <span className="cell-dim"> · CC on every email: {review.sender.ccEmails.join(', ')}</span>}
                </li>
              </ul>
              <div className="otr-scroll" style={{ maxHeight: 220, overflowY: 'auto' }}>
                <table className="otr-table">
                  <tbody>
                    {review.rows
                      .filter((r) => r.status === 'ready')
                      .map((r) => (
                        <tr key={r.position}>
                          <td className="cell-dim">{r.scheduledLocal}</td>
                          <td>{r.companyName}</td>
                          <td className="cell-dim">{r.toEmail}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              <label className="otr-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I reviewed these {review.counts.validEmails} emails and approve sending them at these times.</span>
              </label>
              {!canApprove && <p className="note">Starting a bulk email needs an approver or an administrator.</p>}
              <SendingNote sending={review.sending} />
              {!review.sending.reason && review.sender.problem && (
                <p className="otr-warn">
                  {review.sender.problem} Set or check the sender on the Bulk email page (Back, then Back to all bulk emails).
                </p>
              )}
              <div className="row" style={{ marginTop: 'var(--s3)' }}>
                <Button variant="quiet" onClick={() => setStep('review')}>
                  Back
                </Button>
                <Button
                  variant="primary"
                  icon={Send}
                  disabled={review.counts.validEmails === 0 || !confirmed || !canApprove || Boolean(review.sending.reason) || !review.sender.authorized}
                  busy={call.busy === 'start'}
                  onClick={start}
                >
                  Approve and start sending
                </Button>
              </div>
            </>
          )}
        </>
      )}
    </Panel>
  )
}

function BulkDetail({ id, canOperate, onBack }: { id: string; canOperate: boolean; onBack: () => void }) {
  const state = useAsync<unknown>((signal) => api.get(`/outreach/bulk/${encodeURIComponent(id)}`, { signal }), [id])
  const call = useCall(state.refresh)
  const data = state.data as { campaign?: CampaignRow; counts?: NonNullable<CampaignRow['counts']>; recipients?: RecipientRow[]; sending?: SendingStatus; openTracking?: TrackingSetting } | null
  const c = data?.campaign ?? null
  const counts = data?.counts ?? null
  const recipients = Array.isArray(data?.recipients) ? data!.recipients : []
  usePolling(state.refresh, c?.status === 'running', 30_000)
  const [open, setOpen] = useState<string | null>(null)

  if (state.loading && !data) return <LoadingState what="Reading the bulk email" />
  if (state.error && !data) return <ErrorState error={state.error} what="The bulk email could not be read" onRetry={state.refresh} />
  if (!c || !counts) return <ErrorState error={new Error('The bulk email was not in the response.')} what="The bulk email could not be read" onRetry={state.refresh} />

  const post = (to: string) => call.run(to, () => api.post(`/outreach/bulk/${c.id}/${to}`, {}))
  const processed = counts.sent + counts.failed + counts.skipped

  return (
    <Panel
      title={c.name}
      subtitle={`From ${c.fromEmail} · started ${c.startLocal} · one every ${c.intervalMinutes} min`}
      actions={
        <div className="row">
          <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onBack}>
            All bulk emails
          </Button>
          {canOperate && c.status === 'running' && (
            <Button size="sm" icon={Pause} busy={call.busy === 'pause'} onClick={() => void post('pause')}>
              Pause
            </Button>
          )}
          {canOperate && c.status === 'paused' && (
            <Button size="sm" icon={Play} busy={call.busy === 'resume'} onClick={() => void post('resume')}>
              Resume
            </Button>
          )}
          {canOperate && (c.status === 'running' || c.status === 'paused') && (
            <Button size="sm" variant="danger" icon={Square} busy={call.busy === 'cancel'} onClick={() => void post('cancel')}>
              Cancel unsent
            </Button>
          )}
        </div>
      }
    >
      {c.status === 'completed' && (
        <p className="bulk-ok" role="status">
          <CheckCircle2 size={14} aria-hidden="true" /> <strong>Bulk sequence completed</strong> {c.completedLocal ? `· ${c.completedLocal}` : ''} — {processed} processed: {counts.sent} sent,{' '}
          {counts.failed} failed, {counts.skipped} skipped.
        </p>
      )}
      <SendingNote sending={data?.sending ?? null} />
      {c.status === 'paused' && c.statusReason && (
        <p className="otr-warn" role="alert">
          {c.statusReason}
        </p>
      )}
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      <ul className="otr-list">
        <li>
          {counts.sent} sent · {counts.scheduled} scheduled · {counts.sending} sending · {counts.failed} failed · {counts.skipped} skipped — of {counts.total}
        </li>
        {c.status !== 'completed' && c.estimatedCompletionLocal && <li className="cell-dim">Last email due {c.estimatedCompletionLocal}</li>}
        {counts.opens && counts.opens.sent > 0 && (
          <li aria-label="Open tracking">
            Emails sent {counts.opens.sent} · Open detected {counts.opens.openDetected} · No open detected {counts.opens.noOpenDetected} · Tracking unavailable{' '}
            {counts.opens.trackingUnavailable}
          </li>
        )}
      </ul>
      {counts.opens && counts.opens.sent > 0 && counts.opens.trackingUnavailable < counts.opens.sent && <p className="note">{OPEN_MEANING}</p>}
      {c.status !== 'completed' && c.status !== 'cancelled' && <TrackingNotice setting={data?.openTracking} />}
      <div className="otr-scroll">
        <table className="otr-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>To / CC</th>
              <th>When (IST)</th>
              <th>Status</th>
              <th>Opens</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {recipients.map((r) => {
              const st = RECIPIENT_STATUS[r.status] ?? { word: r.status, tone: 'neutral' as const }
              return (
                <tr key={r.id}>
                  <td>
                    {r.companyName}
                    <div className="cell-dim">
                      {r.contactName ?? ''}
                      {r.version ? ` · Version ${r.version}` : ''}
                    </div>
                    {r.body && (
                      <details open={open === r.id} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open ? r.id : null)}>
                        <summary>Show the email</summary>
                        <p className="cell-dim">{r.subject}</p>
                        <pre className="bulk-body">{r.body}</pre>
                      </details>
                    )}
                  </td>
                  <td className="cell-dim">
                    {r.toEmail ?? '—'}
                    {r.ccEmails.length > 0 && <div>CC: {r.ccEmails.join(', ')}</div>}
                  </td>
                  <td className="cell-dim">{r.sentLocal ?? r.scheduledLocal ?? '—'}</td>
                  <td>
                    <Chip tone={st.tone}>{st.word}</Chip>
                    {r.reason && <div className="cell-dim">{r.reason}</div>}
                  </td>
                  <td>
                    {r.tracking ? (
                      <>
                        <Chip tone={OPEN_STATUS[r.tracking.status].tone}>{OPEN_STATUS[r.tracking.status].word}</Chip>
                        {r.tracking.status === 'open_detected' && (
                          <div className="cell-dim">
                            First {r.tracking.firstOpenedLocal} · last {r.tracking.lastOpenedLocal} · {r.tracking.openCount} detected
                          </div>
                        )}
                        {r.tracking.note && <div className="cell-dim">{r.tracking.note}</div>}
                      </>
                    ) : (
                      <span className="cell-dim">—</span>
                    )}
                  </td>
                  <td>
                    {canOperate && r.toEmail && r.status !== 'skipped' && (
                      <Button size="sm" variant="quiet" icon={UserX} busy={call.busy === `unsub:${r.id}`} onClick={() => void call.run(`unsub:${r.id}`, () => api.post(`/outreach/bulk/recipients/${r.id}/unsubscribe`, {}))}>
                        Unsubscribe
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  )
}
