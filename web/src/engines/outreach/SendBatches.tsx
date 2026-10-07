import { useMemo, useState } from 'react'
import { ArrowLeft, Check, ExternalLink, Pause, Play, Plus, Search, Send, Square } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync, usePolling } from '../../lib/hooks'
import { Button, Chip, Panel, Unset } from '../../components/ui/primitives'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states'
import { useCall } from './useCall'
import { InfoTip } from './InfoTip'
import { buildGmailCompose } from './mailto'
import { fmtDateTime, type SendingStatus } from './types'
import { timeZoneOptions } from './timeZones'
import { TestBatchDetail } from './TestBatches'

// SEVERAL COMPANIES (2026-10-07).
//
//   Select companies → check each address → set the schedule → Review → Send
//
// No draft screens. Review shows every company's first email exactly as it
// will be sent — the approved V1/V2/V3 copy with only the company, product,
// greeting and sender filled in — and any problem. One confirmation covers the
// batch, and Send approves every email and gives each its time. When an
// email's time comes it is listed as due, and the person sends it from their
// own mailbox ("Open in Gmail") and marks it sent: the platform never emails a
// customer itself.

interface Candidate {
  crmCompanyId: string
  companyName: string
  companyDomain: string | null
  decisionMaker: { fullName: string; title: string | null } | null
  intendedRecipient: string | null
  recipientSource: string | null
  ready: boolean
  reason: string | null
  inOutreach?: boolean
}

interface PreviewEmail {
  crmCompanyId: string
  companyName: string
  version: string
  recipientEmail: string | null
  recipientEmailSource: string | null
  decisionMaker: string | null
  subject: string | null
  body: string
  problems: string[]
  /** What Sales can type here when it is all that is missing. */
  fillable: Array<'name' | 'product'>
}

interface BatchRow {
  id: string
  name: string
  mode: string
  status: string
  timezone: string
  sendDays: number[]
  sendStart: string
  sendEnd: string
  spacingMinutes: number
  dailyCap: number
  createdAt: string
  companies?: number
  counts?: { scheduled: number; sent: number; due?: number; awaitingApproval?: number; failed?: number }
}

interface BatchEmail {
  campaignId: string
  crmCompanyId: string
  companyName: string | null
  recipientEmail: string | null
  version: string | null
  actionId: string | null
  state: string
  statusReason: string | null
  scheduledAt: string | null
  sentAt: string | null
  subject: string | null
  body: string | null
}

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const STATUS: Record<string, { word: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' }> = {
  running: { word: 'Sending', tone: 'info' },
  paused: { word: 'Paused', tone: 'warn' },
  completed: { word: 'Completed', tone: 'ok' },
  cancelled: { word: 'Cancelled', tone: 'neutral' },
}
const EMAIL_STATE: Record<string, { word: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'accent' }> = {
  scheduled: { word: 'Scheduled', tone: 'info' },
  due: { word: 'Due now — send it', tone: 'accent' },
  sent: { word: 'Sent', tone: 'ok' },
  needs_attention: { word: 'Needs attention', tone: 'warn' },
  cancelled: { word: 'Cancelled', tone: 'neutral' },
}
const versionWord = (v: string | null) => (v ? `Version ${v.replace(/^v/, '')}` : '')
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

function defaultFirstSend(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`
}

export function SendBatches({
  sending,
  canOperate,
  canApprove,
  onOpenCompany,
  onOpenTestCampaign,
}: {
  sending: SendingStatus | null
  canOperate: boolean
  canApprove: boolean
  /** Opens a company's sequence under One company. */
  onOpenCompany: (c: { crmCompanyId: string; companyName: string }) => void
  /** Opens a campaign of an older TEST batch. */
  onOpenTestCampaign: (c: { crmCompanyId: string; companyName: string; campaignId: string }) => void
}) {
  const [open, setOpen] = useState<{ id: string; mode: string } | null>(null)
  const [creating, setCreating] = useState(false)

  if (creating) {
    return (
      <NewSend
        sending={sending}
        canApprove={canApprove}
        onCancel={() => setCreating(false)}
        onSent={(id) => {
          setCreating(false)
          setOpen({ id, mode: 'manual' })
        }}
      />
    )
  }
  if (open?.mode === 'test') {
    return <TestBatchDetail batchId={open.id} canOperate={canOperate} onBack={() => setOpen(null)} onOpenCampaign={onOpenTestCampaign} />
  }
  if (open) return <SendDetail batchId={open.id} canOperate={canOperate} onBack={() => setOpen(null)} onOpenCompany={onOpenCompany} />
  return <SendList canOperate={canOperate} onOpen={setOpen} onNew={() => setCreating(true)} />
}

function SendList({ canOperate, onOpen, onNew }: { canOperate: boolean; onOpen: (b: { id: string; mode: string }) => void; onNew: () => void }) {
  const list = useAsync<unknown>((signal) => api.get('/outreach/sequence/batches', { signal }), [])
  const rows: BatchRow[] = Array.isArray((list.data as { batches?: unknown } | null)?.batches) ? (list.data as { batches: BatchRow[] }).batches : []

  return (
    <Panel
      title={
        <span className="row">
          Several companies <InfoTip topic="batches" />
        </span>
      }
      subtitle="Choose companies, check each address, set the schedule, review, and send."
      actions={
        canOperate && (
          <Button size="sm" variant="primary" icon={Plus} onClick={onNew}>
            New send
          </Button>
        )
      }
    >
      {list.loading && !list.data ? (
        <Unset what="Loading…" />
      ) : list.error ? (
        <ErrorState error={list.error} what="The sends could not be read" onRetry={list.refresh} />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing sent to several companies yet" detail="Click New send to choose companies, check their addresses and schedule their first emails." />
      ) : (
        <table className="otr-table">
          <thead>
            <tr>
              <th>Send</th>
              <th>Status</th>
              <th>Companies</th>
              <th>Due now</th>
              <th>Scheduled</th>
              <th>Sent</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  {b.name}
                  {b.mode === 'test' && (
                    <>
                      {' '}
                      <Chip tone="neutral">Earlier test run</Chip>
                    </>
                  )}
                  <div className="cell-dim">Created {fmtDateTime(b.createdAt)}</div>
                </td>
                <td>
                  <Chip tone={STATUS[b.status]?.tone ?? 'neutral'}>{STATUS[b.status]?.word ?? b.status}</Chip>
                </td>
                <td className="tnum">{b.companies ?? 0}</td>
                <td className="tnum">{b.mode === 'manual' ? (b.counts?.due ?? 0) : '—'}</td>
                <td className="tnum">{b.counts?.scheduled ?? 0}</td>
                <td className="tnum">{b.counts?.sent ?? 0}</td>
                <td>
                  <Button size="sm" onClick={() => onOpen({ id: b.id, mode: b.mode })}>
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

type Step = 'companies' | 'schedule' | 'review'
const STEPS: Array<{ key: Step; label: string }> = [
  { key: 'companies', label: '1. Companies and addresses' },
  { key: 'schedule', label: '2. Schedule' },
  { key: 'review', label: '3. Review and send' },
]

function NewSend({ sending, canApprove, onCancel, onSent }: { sending: SendingStatus | null; canApprove: boolean; onCancel: () => void; onSent: (id: string) => void }) {
  const candidates = useAsync<unknown>((signal) => api.get('/outreach/sequence/batches/candidates', { signal }), [])
  const list: Candidate[] = Array.isArray((candidates.data as { candidates?: unknown } | null)?.candidates)
    ? (candidates.data as { candidates: Candidate[] }).candidates
    : []
  const max = Number((candidates.data as { max?: number } | null)?.max ?? 10)

  const [step, setStep] = useState<Step>('companies')
  const [picked, setPicked] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [emails, setEmails] = useState<Record<string, string>>({})
  const [names, setNames] = useState<Record<string, string>>({})
  const [products, setProducts] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [firstSend, setFirstSend] = useState(defaultFirstSend())
  const [timezone, setTimezone] = useState('America/New_York')
  const zoneOptions = useMemo(() => timeZoneOptions(), [])
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('17:00')
  const [spacing, setSpacing] = useState('10')
  const [cap, setCap] = useState('20')
  const [preview, setPreview] = useState<PreviewEmail[] | null>(null)
  const [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState<{ batchId: string; scheduled: number; results: Array<{ crmCompanyId: string; companyName: string; ok: boolean; scheduledAt: string | null; error: string | null }> } | null>(null)
  const call = useCall(() => undefined)

  const emailOf = (c: Candidate) => (emails[c.crmCompanyId] ?? '').trim() || c.intendedRecipient || ''
  const canPick = (c: Candidate) => !c.inOutreach && looksLikeEmail(emailOf(c))
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= max ? p : [...p, id]))
  const q = query.trim().toLowerCase()
  const shown = q
    ? list.filter((c) => [c.companyName, c.companyDomain ?? '', c.decisionMaker?.fullName ?? '', c.intendedRecipient ?? '', emails[c.crmCompanyId] ?? ''].join(' ').toLowerCase().includes(q))
    : list
  const hiddenPicked = picked.filter((id) => !shown.some((c) => c.crmCompanyId === id)).length

  const typedRecipients = Object.fromEntries(
    picked.map((id) => [id, (emails[id] ?? '').trim()] as const).filter(([, v]) => v.length > 0 && looksLikeEmail(v)),
  )
  const typedNames = Object.fromEntries(picked.map((id) => [id, (names[id] ?? '').trim()] as const).filter(([, v]) => v.length > 0))
  const typedProducts = Object.fromEntries(picked.map((id) => [id, (products[id] ?? '').trim()] as const).filter(([, v]) => v.length > 0))

  const loadPreview = () =>
    void call.run('preview', async () => {
      const r = (await api.post('/outreach/sequence/batches/preview', {
        crmCompanyIds: picked,
        ...(Object.keys(typedRecipients).length ? { recipients: typedRecipients } : {}),
        ...(Object.keys(typedNames).length ? { names: typedNames } : {}),
        ...(Object.keys(typedProducts).length ? { products: typedProducts } : {}),
      })) as { emails: PreviewEmail[] }
      setPreview(r.emails)
    })

  const sendable = (preview ?? []).filter((e) => e.problems.length === 0)
  const blocked = (preview ?? []).filter((e) => e.problems.length > 0)

  const send = () =>
    void call.run('send', async () => {
      const r = (await api.post('/outreach/sequence/batches/send', {
        ...(name.trim() ? { name: name.trim() } : {}),
        crmCompanyIds: sendable.map((e) => e.crmCompanyId),
        ...(Object.keys(typedRecipients).length ? { recipients: typedRecipients } : {}),
        ...(Object.keys(typedNames).length ? { names: typedNames } : {}),
        ...(Object.keys(typedProducts).length ? { products: typedProducts } : {}),
        firstSendAt: new Date(firstSend).toISOString(),
        timezone,
        sendDays: days,
        sendStart: start,
        sendEnd: end,
        spacingMinutes: Number(spacing),
        dailyCap: Number(cap),
        confirmQueries: confirmed,
      })) as NonNullable<typeof result>
      setResult(r)
    })

  if (result) {
    const failed = result.results.filter((r) => !r.ok)
    return (
      <Panel title="Sent to the schedule" subtitle={`${result.scheduled} first email${result.scheduled === 1 ? '' : 's'} approved and scheduled`}>
        <ul className="otr-list">
          {result.results.map((r) => (
            <li key={r.crmCompanyId}>
              <span className="row">
                <Chip tone={r.ok ? 'ok' : 'danger'}>{r.ok ? 'Scheduled' : 'Not sent'}</Chip>
                <span>{r.companyName}</span>
                {r.scheduledAt && <span className="cell-dim">{fmtDateTime(r.scheduledAt)}</span>}
              </span>
              {r.error && <span className="cell-dim">{r.error}</span>}
            </li>
          ))}
        </ul>
        <p className="note">
          Each email appears as <strong>Due now</strong> at its time. Open it in Gmail, send it from your own mailbox, then click Mark as sent.
          {failed.length > 0 ? ` ${failed.length} compan${failed.length === 1 ? 'y was' : 'ies were'} not sent; the reason is shown above.` : ''}
        </p>
        <div className="row">
          <Button variant="primary" onClick={() => onSent(result.batchId)}>
            Open this send
          </Button>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      title="New send to several companies"
      subtitle="No drafts to open — check the addresses, set the time, review and send"
      actions={
        <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onCancel}>
          Back
        </Button>
      }
    >
      <ol className="otr-wizard" aria-label="Steps">
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

      {step === 'companies' && (
        <>
          <p className="eyebrow">
            Companies ({picked.length} of {max} chosen) — check the address each email goes to
          </p>
          {list.length > 0 && (
            <label className="otr-search">
              <Search size={14} aria-hidden="true" />
              <input
                className="otr-input"
                type="search"
                value={query}
                placeholder="Search by company, decision maker or email"
                aria-label="Search companies"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          )}
          {candidates.loading && !candidates.data ? (
            <LoadingState what="Reading companies with a decision maker" />
          ) : candidates.error ? (
            <ErrorState error={candidates.error} what="The companies could not be read" onRetry={candidates.refresh} />
          ) : list.length === 0 ? (
            <Unset what="No company has a completed Decision Makers run yet" />
          ) : shown.length === 0 ? (
            <Unset what={`No company matches “${query.trim()}”`} />
          ) : (
            <ul className="otr-pick">
              {shown.map((c) => {
                const chosen = picked.includes(c.crmCompanyId)
                const typed = (emails[c.crmCompanyId] ?? '').trim()
                return (
                  <li key={c.crmCompanyId}>
                    <label className="otr-check">
                      <input
                        type="checkbox"
                        checked={chosen}
                        disabled={!canPick(c) || (!chosen && picked.length >= max)}
                        onChange={() => toggle(c.crmCompanyId)}
                      />
                      <span>
                        {c.companyName}
                        {c.decisionMaker && <span className="cell-dim"> · {c.decisionMaker.fullName}</span>}
                        {c.inOutreach ? (
                          <span className="cell-dim"> — already in outreach; continue it under One company</span>
                        ) : (
                          !c.decisionMaker && c.reason && <span className="cell-dim"> — {c.reason}</span>
                        )}
                      </span>
                    </label>
                    {!c.inOutreach && (
                      <div className="otr-pick__email">
                        <span className="field-label">Goes to</span>
                        <input
                          className="otr-input"
                          type="email"
                          value={emails[c.crmCompanyId] ?? c.intendedRecipient ?? ''}
                          placeholder="name@company.com"
                          aria-label={`Email address for ${c.companyName}`}
                          onChange={(e) => setEmails((prev) => ({ ...prev, [c.crmCompanyId]: e.target.value }))}
                        />
                        <span className="cell-dim">
                          {typed && typed !== (c.intendedRecipient ?? '')
                            ? 'you typed this'
                            : c.recipientSource === 'company_mailbox'
                              ? 'company mailbox'
                              : c.intendedRecipient
                                ? 'from Decision Makers'
                                : 'nothing was found — type one to include this company'}
                        </span>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          {hiddenPicked > 0 && (
            <p className="note">
              {hiddenPicked} chosen {hiddenPicked === 1 ? 'company is' : 'companies are'} hidden by the search. {hiddenPicked === 1 ? 'It is' : 'They are'} still chosen.
            </p>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button variant="primary" disabled={picked.length === 0} onClick={() => setStep('schedule')}>
              Next: schedule
            </Button>
          </div>
        </>
      )}

      {step === 'schedule' && (
        <>
          <p className="note">
            When the first emails become due, how far apart, and how many a day. Follow-up timing stays the approved PDF timing.
          </p>
          <div className="otr-grid">
            <label>
              <span className="field-label">Name (optional)</span>
              <input className="otr-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span className="field-label">First emails due from (your local time)</span>
              <input className="otr-input" type="datetime-local" value={firstSend} onChange={(e) => setFirstSend(e.target.value)} />
            </label>
            <label>
              <span className="field-label">Sending time zone</span>
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
              <span className="field-label">Sending hours from</span>
              <input className="otr-input" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            </label>
            <label>
              <span className="field-label">until</span>
              <input className="otr-input" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
            <label>
              <span className="field-label">Minutes between companies</span>
              <input className="otr-input" type="number" min={1} max={240} value={spacing} onChange={(e) => setSpacing(e.target.value)} />
            </label>
            <label>
              <span className="field-label">At most per day</span>
              <input className="otr-input" type="number" min={1} max={200} value={cap} onChange={(e) => setCap(e.target.value)} />
            </label>
          </div>
          <div className="row" role="group" aria-label="Sending days" style={{ marginTop: 'var(--s2)' }}>
            {DAY.map((d, i) => (
              <label key={d} className="otr-check">
                <input
                  type="checkbox"
                  checked={days.includes(i + 1)}
                  onChange={() => setDays((p) => (p.includes(i + 1) ? p.filter((x) => x !== i + 1) : [...p, i + 1].sort()))}
                />
                {d}
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 'var(--s4)' }}>
            <Button variant="quiet" onClick={() => setStep('companies')}>
              Back
            </Button>
            <Button
              variant="primary"
              disabled={days.length === 0 || !firstSend}
              busy={call.busy === 'preview'}
              onClick={() => {
                setConfirmed(false)
                setPreview(null)
                setStep('review')
                loadPreview()
              }}
            >
              Next: review
            </Button>
          </div>
        </>
      )}

      {step === 'review' && (
        <>
          <ul className="otr-list">
            <li>
              First emails due from {firstSend.replace('T', ' ')} (your time), {start}–{end} {timezone}, {days.map((d) => DAY[d - 1]).join(' ')}
            </li>
            <li>
              {spacing} minutes apart, at most {cap} a day
            </li>
            <li>Each email is sent by you, from your own mailbox, when it is due — the platform never emails a customer itself.</li>
          </ul>
          {!preview ? (
            <LoadingState what="Preparing each company’s email" />
          ) : (
            <div className="otr-review">
              {preview.map((e) => (
                <article key={e.crmCompanyId} className={`otr-review__email${e.problems.length ? ' is-blocked' : ''}`}>
                  <header className="row">
                    <strong>{e.companyName}</strong>
                    <Chip tone="neutral">{versionWord(e.version)}</Chip>
                    {e.problems.length ? <Chip tone="danger">Will not be sent</Chip> : <Chip tone="ok">Ready</Chip>}
                  </header>
                  <p className="cell-dim">To: {e.recipientEmail ?? '—'}</p>
                  {e.subject && (
                    <p>
                      <span className="field-label">Subject</span> {e.subject}
                    </p>
                  )}
                  <details>
                    <summary>Show the email</summary>
                    <pre className="otr-review__body">{e.body}</pre>
                  </details>
                  {e.problems.map((p) => (
                    <p key={p} className="otr-err">
                      {p}
                    </p>
                  ))}
                  {e.fillable.length > 0 && (
                    <div className="otr-pick__email">
                      {e.fillable.includes('name') && (
                        <>
                          <span className="field-label">Greeting name</span>
                          <input
                            className="otr-input"
                            value={names[e.crmCompanyId] ?? ''}
                            placeholder="e.g. Joe"
                            aria-label={`Greeting name for ${e.companyName}`}
                            onChange={(ev) => setNames((prev) => ({ ...prev, [e.crmCompanyId]: ev.target.value }))}
                          />
                        </>
                      )}
                      {e.fillable.includes('product') && (
                        <>
                          <span className="field-label">Product name</span>
                          <input
                            className="otr-input"
                            value={products[e.crmCompanyId] ?? ''}
                            placeholder="e.g. safety helmets"
                            aria-label={`Product name for ${e.companyName}`}
                            onChange={(ev) => setProducts((prev) => ({ ...prev, [e.crmCompanyId]: ev.target.value }))}
                          />
                        </>
                      )}
                      <Button size="sm" busy={call.busy === 'preview'} onClick={() => loadPreview()}>
                        {e.fillable.length > 1 ? 'Use these' : e.fillable[0] === 'name' ? 'Use this name' : 'Use this product'}
                      </Button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
          {preview && (
            <>
              {blocked.length > 0 && (
                <p className="note">
                  {blocked.length} compan{blocked.length === 1 ? 'y' : 'ies'} will not be sent, for the reason shown. The other {sendable.length} will.
                </p>
              )}
              <label className="otr-check">
                <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                <span>I confirm the queries these emails describe were run for each company.</span>
              </label>
              {!canApprove && <p className="note">Sending approves these emails, so it needs an approver or an administrator.</p>}
              {sending && sending.mode === 'test' && (
                <p className="note">The platform is in test mode; this send is a real send and its emails are sent by you, not by the platform.</p>
              )}
            </>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button variant="quiet" onClick={() => setStep('schedule')}>
              Back
            </Button>
            <Button
              variant="primary"
              icon={Send}
              disabled={!preview || sendable.length === 0 || !confirmed || !canApprove}
              busy={call.busy === 'send'}
              onClick={send}
            >
              Send {sendable.length > 0 ? `${sendable.length} email${sendable.length === 1 ? '' : 's'}` : ''}
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

function SendDetail({
  batchId,
  canOperate,
  onBack,
  onOpenCompany,
}: {
  batchId: string
  canOperate: boolean
  onBack: () => void
  onOpenCompany: (c: { crmCompanyId: string; companyName: string }) => void
}) {
  const state = useAsync<unknown>((signal) => api.get(`/outreach/sequence/batches/${encodeURIComponent(batchId)}`, { signal }), [batchId])
  const call = useCall(state.refresh)
  // An email becomes due on its own; the list is read again each minute.
  usePolling(state.refresh, true, 60_000)
  const data = state.data as { batch?: BatchRow; emails?: BatchEmail[] } | null
  const batch = data?.batch ?? null
  const emails = Array.isArray(data?.emails) ? data!.emails : []
  const [openedGmail, setOpenedGmail] = useState<Record<string, boolean>>({})

  if (state.loading && !data) return <LoadingState what="Reading this send" />
  if (state.error && !data) return <ErrorState error={state.error} what="This send could not be read" onRetry={state.refresh} />
  if (!batch) return <ErrorState error={new Error('The send was not in the response.')} what="This send could not be read" onRetry={state.refresh} />

  const running = batch.status === 'running'
  const open = running || batch.status === 'paused'
  const post = (to: string) => call.run(to, () => api.post(`/outreach/sequence/batches/${batch.id}/${to}`, {}))

  return (
    <Panel
      title={batch.name}
      subtitle={`${STATUS[batch.status]?.word ?? batch.status} · ${batch.sendStart}–${batch.sendEnd} ${batch.timezone}, ${batch.sendDays
        .map((d) => DAY[d - 1])
        .join(' ')} · ${batch.spacingMinutes} min apart · at most ${batch.dailyCap}/day`}
      actions={
        <div className="row">
          <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onBack}>
            All sends
          </Button>
          {canOperate && running && (
            <Button size="sm" icon={Pause} busy={call.busy === 'pause'} onClick={() => void post('pause')}>
              Pause
            </Button>
          )}
          {canOperate && batch.status === 'paused' && (
            <Button size="sm" icon={Play} busy={call.busy === 'resume'} onClick={() => void post('resume')}>
              Resume
            </Button>
          )}
          {canOperate && open && (
            <Button size="sm" variant="danger" icon={Square} busy={call.busy === 'cancel'} onClick={() => void post('cancel')}>
              Cancel unsent emails
            </Button>
          )}
        </div>
      }
    >
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      {batch.status === 'paused' && <p className="note">Paused — no email is shown as due until you resume.</p>}
      {emails.length === 0 ? (
        <Unset what="No company in this send" />
      ) : (
        <table className="otr-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>Email</th>
              <th>When</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {emails.map((e) => {
              const st = EMAIL_STATE[e.state] ?? { word: e.state, tone: 'neutral' as const }
              const due = e.state === 'due' && running
              return (
                <tr key={e.campaignId}>
                  <td>
                    {e.companyName ?? e.crmCompanyId}
                    <div className="cell-dim">To: {e.recipientEmail ?? '—'}</div>
                  </td>
                  <td>
                    <span className="cell-dim">{versionWord(e.version)}</span>
                    {e.subject && <div>{e.subject}</div>}
                    {e.body && (
                      <details>
                        <summary>Show the email</summary>
                        <pre className="otr-review__body">{e.body}</pre>
                      </details>
                    )}
                  </td>
                  <td className="cell-dim">{e.state === 'sent' ? fmtDateTime(e.sentAt) : fmtDateTime(e.scheduledAt)}</td>
                  <td>
                    <Chip tone={e.state === 'due' && !running ? 'info' : st.tone}>{e.state === 'due' && !running ? 'Waiting (paused)' : st.word}</Chip>
                    {e.statusReason && e.state !== 'sent' && <div className="cell-dim">{e.statusReason}</div>}
                  </td>
                  <td>
                    {due && e.actionId && canOperate && (
                      <div className="row">
                        <a
                          className="btn btn--sm"
                          href={buildGmailCompose(e.recipientEmail, e.subject, e.body ?? '')}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={() => setOpenedGmail((p) => ({ ...p, [e.campaignId]: true }))}
                        >
                          <ExternalLink size={14} aria-hidden="true" /> Open in Gmail
                        </a>
                        <Button
                          size="sm"
                          variant={openedGmail[e.campaignId] ? 'primary' : undefined}
                          icon={Check}
                          busy={call.busy === `sent:${e.actionId}`}
                          onClick={() => void call.run(`sent:${e.actionId}`, () => api.post(`/outreach/sequence/actions/${e.actionId}/mark-sent`, {}))}
                        >
                          Mark as sent
                        </Button>
                      </div>
                    )}
                    {e.state === 'needs_attention' && (
                      <Button size="sm" onClick={() => onOpenCompany({ crmCompanyId: e.crmCompanyId, companyName: e.companyName ?? e.crmCompanyId })}>
                        Open under One company
                      </Button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
      <p className="note">
        After an email is marked sent, that company continues under One company: replies and follow-ups on the approved PDF timing.
      </p>
    </Panel>
  )
}
