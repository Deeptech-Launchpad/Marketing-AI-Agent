import { useMemo, useRef, useState } from 'react'
import { ArrowLeft, CheckCircle2, FileSpreadsheet, Pause, Play, Plus, Send, Square, UserX } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync, usePolling } from '../../lib/hooks'
import { Button, Chip, Panel, Unset } from '../../components/ui/primitives'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states'
import { useBulkCall as useCall } from './useBulkCall'
import { timeZoneOptions } from './bulkTimeZones'
import './bulk.css'

// OUTREACH → BULK EMAIL (2026-10-07). A completely standalone workflow: its
// own upload, processing, email, sender settings, schedule, review, approval,
// sending and tracking, sharing no code with One company or Several companies.
//
//   1. Upload the Excel file   2. Sender, CC, signature   3. Schedule
//   4. Review every email      5. Approve and start sending
//
// The approved static template is used word for word — only [First Name] and
// [Company Name] are filled. One email per company: the first named person
// receives it, colleagues are copied. The PLATFORM sends them, one at a time,
// from the company mailbox configured on the server, interval minutes apart,
// inside the sending hours, under the daily limit — in the chosen time zone.

interface SendingStatus {
  enabled: boolean
  mailboxConfigured: boolean
  senders: string[]
  reason: string | null
  maxPerDay: number
}
interface Settings {
  sending: SendingStatus
  templates: Array<{ key: string; label: string; subject: string; body: string; placeholders: string[] }>
  defaults: { timezone: string; startTime: string; sendStart: string; sendEnd: string; sendDays: number[]; intervalMinutes: number; dailyCap: number }
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
  status: 'ready' | 'skipped'
  reason: string | null
  scheduledLocal: string | null
}
interface Review {
  fileName: string | null
  counts: { rowsWithCompany: number; companies: number; validEmails: number; skipped: number; noWorkAddress: number }
  rows: ReviewRow[]
  noAddress: Array<{ row: number; companyName: string; reason: string }>
  schedule: { timezone: string; startLocal: string; firstLocal: string | null; estimatedCompletionLocal: string | null; intervalMinutes: number; dailyCap: number }
  from: { email: string | null; name: string | null }
  sending: SendingStatus
}
interface CampaignRow {
  id: string
  name: string
  status: string
  fromEmail: string
  timezone: string
  startLocal: string
  sendHours: string
  intervalMinutes: number
  dailyCap: number
  createdAt: string
  completedLocal: string | null
  estimatedCompletionLocal?: string | null
  counts?: { scheduled: number; sending: number; sent: number; failed: number; skipped: number; total: number }
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
}

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
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

/** "08:00" → "8:00 AM". */
function ampm(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm)
  if (!m) return hhmm
  const h = Number(m[1])
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`
}

function tomorrow(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
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
  return <BulkList canOperate={canOperate} onOpen={setOpenId} onNew={() => setCreating(true)} />
}

function SendingNote({ sending }: { sending: SendingStatus | null }) {
  if (!sending || !sending.reason) return null
  return <p className="otr-warn">{sending.reason} Nothing is sent until an administrator configures the sending mailbox on the server.</p>
}

function BulkList({ canOperate, onOpen, onNew }: { canOperate: boolean; onOpen: (id: string) => void; onNew: () => void }) {
  const list = useAsync<unknown>((signal) => api.get('/outreach/bulk', { signal }), [])
  const data = list.data as { campaigns?: CampaignRow[]; sending?: SendingStatus } | null
  const rows = Array.isArray(data?.campaigns) ? data!.campaigns : []
  usePolling(list.refresh, rows.some((r) => r.status === 'running'), 60_000)
  return (
    <Panel
      title="Bulk email"
      subtitle="Upload an Excel list, check every email, and the platform sends them one at a time on your schedule."
      actions={
        canOperate && (
          <Button size="sm" variant="primary" icon={Plus} onClick={onNew}>
            New bulk email
          </Button>
        )
      }
    >
      <SendingNote sending={data?.sending ?? null} />
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
                </td>
                <td className="tnum">{c.counts?.sent ?? 0}</td>
                <td className="tnum">{c.counts?.scheduled ?? 0}</td>
                <td className="tnum">{c.counts?.failed ?? 0}</td>
                <td className="tnum">{c.counts?.skipped ?? 0}</td>
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

type Step = 'upload' | 'sender' | 'schedule' | 'review'
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'upload', label: '1. Upload Excel' },
  { key: 'sender', label: '2. Sender, CC and signature' },
  { key: 'schedule', label: '3. Schedule' },
  { key: 'review', label: '4. Review and start' },
]

function NewBulk({ canApprove, onCancel, onStarted }: { canApprove: boolean; onCancel: () => void; onStarted: (id: string) => void }) {
  const settingsState = useAsync<unknown>((signal) => api.get('/outreach/bulk/settings', { signal }), [])
  const settings = settingsState.data as Settings | null
  const template = settings?.templates[0] ?? null
  const sending = settings?.sending ?? null
  const zoneOptions = useMemo(() => timeZoneOptions(new Date(), ['America/Indiana/Indianapolis']), [])

  const [step, setStep] = useState<Step>('upload')
  const [file, setFile] = useState<{ name: string; base64: string } | null>(null)
  // Test option (off by default): also use webmail addresses, for a first run
  // with the team's own gmail / yahoo addresses.
  const [allowWebmail, setAllowWebmail] = useState(false)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [fromEmail, setFromEmail] = useState('')
  const [fromName, setFromName] = useState('')
  const [cc, setCc] = useState('')
  const [signature, setSignature] = useState('')
  const [postal, setPostal] = useState('')
  const [startDate, setStartDate] = useState(tomorrow())
  const [startTime, setStartTime] = useState('08:00')
  const [timezone, setTimezone] = useState('America/Indiana/Indianapolis')
  const [sendStart, setSendStart] = useState('08:00')
  const [sendEnd, setSendEnd] = useState('17:00')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [interval, setIntervalMinutes] = useState('5')
  const [cap, setCap] = useState('100')
  const [review, setReview] = useState<Review | null>(null)
  const [previewPos, setPreviewPos] = useState<number | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const call = useCall(() => undefined)
  const fileInput = useRef<HTMLInputElement>(null)

  const chosenFrom = fromEmail || sending?.senders[0] || ''
  const ccList = cc.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
  const ccBad = ccList.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))

  const readFile = async (picked: { name: string; base64: string }, webmail: boolean) => {
    setAnalysis(null)
    setReview(null)
    const r = (await api.post('/outreach/bulk/analyze', { fileBase64: picked.base64, fileName: picked.name, allowWebmail: webmail })) as Analysis
    setAnalysis(r)
  }
  /** Read again, e.g. after the webmail option changed. One request at a time. */
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
    fromEmail: chosenFrom,
    fromName: fromName.trim() || null,
    ccEmails: ccList,
    signature,
    postalAddress: postal,
    startDate,
    startTime,
    timezone,
    sendStart,
    sendEnd,
    sendDays: days,
    intervalMinutes: Number(interval),
    dailyCap: Number(cap),
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

  return (
    <Panel
      title="New bulk email"
      subtitle="The approved template, word for word — only [First Name] and [Company Name] are filled in"
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
      <SendingNote sending={sending} />
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}

      {step === 'upload' && (
        <>
          <p className="note">
            Upload the Excel file (.xlsx). The first sheet is read: the company name, each contact&rsquo;s name and email, and the Status
            column. One email goes to each company — the first named person receives it, colleagues are copied.
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
                  <strong>{analysis.totalRows}</strong> rows with a company · <strong>{analysis.companies.length}</strong> companies
                </li>
                <li>
                  <strong>{sendable.length}</strong> companies with a valid work email address ·{' '}
                  {analysis.companies.filter((c) => c.skip).length} skipped by Status · {analysis.noAddress.length} rows with no usable work address
                </li>
                <li className="cell-dim">
                  Columns read: {analysis.columns.company} · {analysis.columns.contacts.map((c) => `${c.name ?? '—'} / ${c.email}`).join(' · ')}
                  {analysis.columns.status ? ` · ${analysis.columns.status}` : ''}
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
                          <td>
                            {c.companyName}
                            <div className="cell-dim">row {c.rows.join(', ')}</div>
                          </td>
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
            <Button variant="primary" disabled={!analysis || sendable.length === 0} onClick={() => setStep('sender')}>
              Next: sender
            </Button>
          </div>
        </>
      )}

      {step === 'sender' && (
        <>
          <div className="otr-grid">
            <label>
              <span className="field-label">From / sender email</span>
              {sending && sending.senders.length > 0 ? (
                <select className="otr-input" value={chosenFrom} onChange={(e) => setFromEmail(e.target.value)}>
                  {sending.senders.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              ) : (
                <Unset what="No sending mailbox is configured on the server" />
              )}
            </label>
            <label>
              <span className="field-label">Sender name (optional)</span>
              <input className="otr-input" value={fromName} maxLength={80} placeholder="e.g. Manoj | AltiusNxt" onChange={(e) => setFromName(e.target.value)} />
            </label>
            <label>
              <span className="field-label">CC on every email (optional)</span>
              <input className="otr-input" value={cc} placeholder="name@altiusnxt.com, …" onChange={(e) => setCc(e.target.value)} />
            </label>
          </div>
          {ccBad.length > 0 && <p className="otr-err">Not an email address: {ccBad.join(', ')}</p>}
          <label className="field-label" htmlFor="bulk-signature" style={{ marginTop: 'var(--s3)' }}>
            Signature
          </label>
          <textarea id="bulk-signature" className="textarea" rows={4} maxLength={1000} value={signature} onChange={(e) => setSignature(e.target.value)} />
          <label className="field-label" htmlFor="bulk-postal" style={{ marginTop: 'var(--s3)' }}>
            Postal address for the opt-out footer (required by US law)
          </label>
          <input id="bulk-postal" className="otr-input" maxLength={300} value={postal} placeholder="Street, City, State ZIP, Country" onChange={(e) => setPostal(e.target.value)} />
          {template && (
            <details style={{ marginTop: 'var(--s3)' }}>
              <summary>The approved template ({template.label}) — used word for word</summary>
              <p>
                <span className="field-label">Subject</span> {template.subject}
              </p>
              <pre className="bulk-body">{template.body.split('\n').join('\n\n')}</pre>
            </details>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button variant="quiet" onClick={() => setStep('upload')}>
              Back
            </Button>
            <Button variant="primary" disabled={ccBad.length > 0 || !postal.trim()} onClick={() => setStep('schedule')}>
              Next: schedule
            </Button>
          </div>
          {/* Why the button is greyed out, in words — it used to be silent. */}
          {(!postal.trim() || ccBad.length > 0) && (
            <p className="otr-warn" role="status">
              {!postal.trim() ? 'Enter the postal address to continue — US law requires it in the opt-out line.' : 'Fix the CC address to continue.'}
            </p>
          )}
          {!chosenFrom && postal.trim() && (
            <p className="note">You can schedule and review now. Starting needs a sending mailbox configured on the server.</p>
          )}
        </>
      )}

      {step === 'schedule' && (
        <>
          <div className="otr-grid">
            <label>
              <span className="field-label">Start date</span>
              <input className="otr-input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </label>
            <label>
              <span className="field-label">Start time ({ampm(startTime)})</span>
              <input className="otr-input" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </label>
            <label>
              <span className="field-label">Time zone</span>
              <select className="otr-input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                <optgroup label="Common">
                  {zoneOptions.common.map((z) => (
                    <option key={z.value} value={z.value}>
                      {z.label}
                    </option>
                  ))}
                </optgroup>
                {zoneOptions.others.length > 0 && (
                  <optgroup label="All time zones">
                    {zoneOptions.others.map((z) => (
                      <option key={z.value} value={z.value}>
                        {z.label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
            <label>
              <span className="field-label">Sending hours from ({ampm(sendStart)})</span>
              <input className="otr-input" type="time" value={sendStart} onChange={(e) => setSendStart(e.target.value)} />
            </label>
            <label>
              <span className="field-label">until ({ampm(sendEnd)})</span>
              <input className="otr-input" type="time" value={sendEnd} onChange={(e) => setSendEnd(e.target.value)} />
            </label>
            <label>
              <span className="field-label">Minutes between emails</span>
              <input className="otr-input" type="number" min={1} max={240} value={interval} onChange={(e) => setIntervalMinutes(e.target.value)} />
            </label>
            <label>
              <span className="field-label">At most per day{sending ? ` (up to ${sending.maxPerDay})` : ''}</span>
              <input className="otr-input" type="number" min={1} max={sending?.maxPerDay ?? 200} value={cap} onChange={(e) => setCap(e.target.value)} />
            </label>
          </div>
          <div className="row" role="group" aria-label="Sending days" style={{ marginTop: 'var(--s2)' }}>
            {DAY.map((d, i) => (
              <label key={d} className="otr-check">
                <input type="checkbox" checked={days.includes(i + 1)} onChange={() => setDays((p) => (p.includes(i + 1) ? p.filter((x) => x !== i + 1) : [...p, i + 1].sort()))} />
                {d}
              </label>
            ))}
          </div>
          <p className="note">
            Emails go one at a time, {interval || '…'} minutes apart, only {ampm(sendStart)}–{ampm(sendEnd)} {timezone.replace(/_/g, ' ')} time, at most {cap || '…'} a day. When
            the day&rsquo;s limit or hours run out, the rest continue in the next allowed period.
          </p>
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button variant="quiet" onClick={() => setStep('sender')}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={!startDate || !startTime || days.length === 0}
              busy={call.busy === 'review'}
              onClick={() => {
                setConfirmed(false)
                setReview(null)
                setStep('review')
                loadReview()
              }}
            >
              Next: review
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
              <dl className="enrich__readout">
                <div>
                  <dt>Contacts</dt>
                  <dd>
                    {review.counts.companies} companies · <strong>{review.counts.validEmails} emails will be sent</strong> · {review.counts.skipped} skipped ·{' '}
                    {review.counts.noWorkAddress} rows with no usable work address
                  </dd>
                </div>
                <div>
                  <dt>From</dt>
                  <dd>
                    {review.from.email
                      ? review.from.name
                        ? `${review.from.name} <${review.from.email}>`
                        : review.from.email
                      : 'No sending mailbox configured on the server yet'}
                    {ccList.length > 0 ? ` · CC on every email: ${ccList.join(', ')}` : ''}
                  </dd>
                </div>
                <div>
                  <dt>Schedule</dt>
                  <dd>
                    First email {review.schedule.firstLocal ?? '—'} ({review.schedule.timezone.replace(/_/g, ' ')}), {review.schedule.intervalMinutes} minutes apart, at most{' '}
                    {review.schedule.dailyCap} a day, {ampm(sendStart)}–{ampm(sendEnd)} {days.map((d) => DAY[d - 1]).join(' ')}
                  </dd>
                </div>
                <div>
                  <dt>Estimated completion</dt>
                  <dd>{review.schedule.estimatedCompletionLocal ?? '—'}</dd>
                </div>
              </dl>
              <div className="otr-scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="otr-table">
                  <thead>
                    <tr>
                      <th>Company</th>
                      <th>Person</th>
                      <th>To</th>
                      <th>CC</th>
                      <th>When</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {review.rows.map((r) => (
                      <tr key={r.position} aria-selected={r.position === previewPos}>
                        <td>{r.companyName}</td>
                        <td>{r.contactName ?? '—'}</td>
                        <td>{r.toEmail ?? '—'}</td>
                        <td className="cell-dim">{r.ccEmails.join(', ') || '—'}</td>
                        <td className="cell-dim">{r.status === 'ready' ? r.scheduledLocal : <Chip tone="neutral">Skipped</Chip>}</td>
                        <td>
                          {r.status === 'ready' ? (
                            <Button size="sm" variant="quiet" onClick={() => setPreviewPos(r.position)}>
                              Preview
                            </Button>
                          ) : (
                            <span className="cell-dim">{r.reason}</span>
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
                    {preview.ccEmails.length ? ` · CC: ${preview.ccEmails.join(', ')}` : ''} · {preview.scheduledLocal}
                  </p>
                  <p>
                    <span className="field-label">Subject</span> {preview.subject}
                  </p>
                  <pre className="bulk-body">{preview.text}</pre>
                </article>
              )}
              <label className="otr-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>
                  I reviewed this list and approve sending {review.counts.validEmails} emails from {review.from.email ?? 'the configured mailbox'} on this schedule.
                </span>
              </label>
              {!canApprove && <p className="note">Starting a bulk email needs an approver or an administrator.</p>}
              <SendingNote sending={review.sending} />
            </>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button variant="quiet" onClick={() => setStep('schedule')}>
              Back
            </Button>
            <Button
              variant="primary"
              icon={Send}
              disabled={!review || review.counts.validEmails === 0 || !confirmed || !canApprove || Boolean(review.sending.reason) || !review.from.email}
              busy={call.busy === 'start'}
              onClick={start}
            >
              Approve and start sending
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

function BulkDetail({ id, canOperate, onBack }: { id: string; canOperate: boolean; onBack: () => void }) {
  const state = useAsync<unknown>((signal) => api.get(`/outreach/bulk/${encodeURIComponent(id)}`, { signal }), [id])
  const call = useCall(state.refresh)
  const data = state.data as { campaign?: CampaignRow; counts?: NonNullable<CampaignRow['counts']>; recipients?: RecipientRow[]; sending?: SendingStatus } | null
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
      subtitle={`From ${c.fromEmail} · ${c.intervalMinutes} min apart · ${c.sendHours} ${c.timezone.replace(/_/g, ' ')} · at most ${c.dailyCap}/day`}
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
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      <ul className="otr-list">
        <li>
          {counts.sent} sent · {counts.scheduled} scheduled · {counts.sending} sending · {counts.failed} failed · {counts.skipped} skipped — of {counts.total}
        </li>
        {c.status !== 'completed' && c.estimatedCompletionLocal && <li className="cell-dim">Estimated completion {c.estimatedCompletionLocal}</li>}
      </ul>
      <div className="otr-scroll">
        <table className="otr-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>To / CC</th>
              <th>When</th>
              <th>Status</th>
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
                    <div className="cell-dim">{r.contactName ?? ''}</div>
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
      <p className="note">Created {fmtDateTime(c.createdAt)}. When a contact replies &ldquo;unsubscribe&rdquo;, click Unsubscribe: they are added to the suppression list and never emailed again.</p>
    </Panel>
  )
}
