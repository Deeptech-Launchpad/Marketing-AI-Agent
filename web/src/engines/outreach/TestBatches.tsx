import { useState } from 'react'
import { ArrowLeft, FileEdit, FlaskConical, Pause, Play, Plus, Search, Square } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { Button, Chip, Panel, Unset } from '../../components/ui/primitives'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states'
import { useCall } from './useCall'
import { InfoTip } from './InfoTip'
import { emailStatus, stepStatus } from './status'
import { PHASE_LABEL, fmtDateTime, fmtWindow, type Phase, type SendingStatus } from './types'

// TEST BATCHES (2026-09-28).
//
// A rehearsal of the approved sequence for up to 10 companies. Creating a
// batch drafts every company's initial email at once; Sales reviews and
// approves each one individually; only approved emails are scheduled; and the
// test sender delivers them to the INTERNAL test inbox — the customer is never
// emailed. Follow-ups are drafted when the PDF timing allows, and each needs
// its own approval. A confirmed reply stops that company's no-reply follow-ups.

interface BatchRow {
  id: string
  name: string
  status: string
  firstSendAt: string
  timezone: string
  sendDays: number[]
  sendStart: string
  sendEnd: string
  spacingMinutes: number
  dailyCap: number
  createdAt: string
  companies?: number
  counts?: { awaitingApproval: number; scheduled: number; sent: number; failed: number }
}

interface StageCell {
  stageKey: string
  pdfRef: string
  label: string
  track: string
  stageStatus: string
  reason: string | null
  window: { start: string; end: string } | null
  actionId: string | null
  actionStatus: string | null
  statusReason: string | null
  scheduledAt: string | null
  sentAt: string | null
  sentVia: string | null
  lastAttempt: { status: string; at: string; error: string | null; to: unknown } | null
}

interface BatchCompany {
  campaignId: string
  crmCompanyId: string
  companyName: string | null
  status: string
  statusReason: string | null
  intendedRecipient: string | null
  phase: Phase
  stages: StageCell[]
}

interface Candidate {
  crmCompanyId: string
  companyName: string
  companyDomain: string | null
  decisionMaker: { fullName: string; title: string | null } | null
  intendedRecipient: string | null
  recipientSource: string | null
  ready: boolean
  reason: string | null
}

const BATCH_STATUS: Record<string, { word: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' }> = {
  running: { word: 'Running', tone: 'info' },
  paused: { word: 'Paused', tone: 'warn' },
  completed: { word: 'Completed', tone: 'ok' },
  cancelled: { word: 'Cancelled', tone: 'neutral' },
}

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const COLUMNS = ['initial', 'noreply_followup', 'noreply_report', 'expo_invite', 'breakup']
const REPLY_STAGES = ['reply_followup', 'sku_report', 'expo_cannot_attend']

export function TestBatches({
  sending,
  canOperate,
  onOpenCampaign,
}: {
  sending: SendingStatus | null
  canOperate: boolean
  onOpenCampaign: (c: { crmCompanyId: string; companyName: string; campaignId: string }) => void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  if (creating) {
    return (
      <CreateBatch
        sending={sending}
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false)
          setOpenId(id)
        }}
      />
    )
  }
  if (openId) return <BatchDetail batchId={openId} canOperate={canOperate} onBack={() => setOpenId(null)} onOpenCampaign={onOpenCampaign} />
  return <BatchList canOperate={canOperate} onOpen={setOpenId} onNew={() => setCreating(true)} />
}

function BatchList({ canOperate, onOpen, onNew }: { canOperate: boolean; onOpen: (id: string) => void; onNew: () => void }) {
  const list = useAsync<unknown>((signal) => api.get('/outreach/sequence/batches', { signal }), [])
  const rows: BatchRow[] = Array.isArray((list.data as { batches?: unknown } | null)?.batches) ? (list.data as { batches: BatchRow[] }).batches : []

  return (
    <Panel
      title={
        <span className="row">
          Several companies (test run) <InfoTip topic="batches" />
        </span>
      }
      subtitle="Draft the first email for up to 10 companies at once. Emails go only to the internal test inbox."
      actions={
        canOperate && (
          <Button size="sm" variant="primary" icon={Plus} onClick={onNew}>
            New test batch
          </Button>
        )
      }
    >
      {list.loading && !list.data ? (
        <Unset what="Loading…" />
      ) : list.error ? (
        <ErrorState error={list.error} what="The test batches could not be read" onRetry={list.refresh} />
      ) : rows.length === 0 ? (
        <EmptyState title="No test batches yet" detail="A test batch drafts the initial email for up to 10 companies. Each email is sent — to the internal test inbox only — after Sales approves it." />
      ) : (
        <table className="otr-table">
          <thead>
            <tr>
              <th>Batch</th>
              <th>Status</th>
              <th>Companies</th>
              <th>Waiting for approval</th>
              <th>Scheduled</th>
              <th>Sent (test)</th>
              <th>Failed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr key={b.id}>
                <td>
                  {b.name}
                  <div className="cell-dim">Created {fmtDateTime(b.createdAt)}</div>
                </td>
                <td>
                  <Chip tone={BATCH_STATUS[b.status]?.tone ?? 'neutral'}>{BATCH_STATUS[b.status]?.word ?? b.status}</Chip>
                </td>
                <td className="tnum">{b.companies ?? 0}</td>
                <td className="tnum">{b.counts?.awaitingApproval ?? 0}</td>
                <td className="tnum">{b.counts?.scheduled ?? 0}</td>
                <td className="tnum">{b.counts?.sent ?? 0}</td>
                <td className="tnum">{b.counts?.failed ?? 0}</td>
                <td>
                  <Button size="sm" onClick={() => onOpen(b.id)}>
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

function defaultFirstSend(): string {
  // Tomorrow 09:00 in the browser's time, as a datetime-local value.
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00`
}

function CreateBatch({ sending, onCancel, onCreated }: { sending: SendingStatus | null; onCancel: () => void; onCreated: (id: string) => void }) {
  const candidates = useAsync<unknown>((signal) => api.get('/outreach/sequence/batches/candidates', { signal }), [])
  const list: Candidate[] = Array.isArray((candidates.data as { candidates?: unknown } | null)?.candidates)
    ? (candidates.data as { candidates: Candidate[] }).candidates
    : []
  const max = Number((candidates.data as { max?: number } | null)?.max ?? 10)

  const [picked, setPicked] = useState<string[]>([])
  /** What Sales typed into the search box, to narrow a long list. */
  const [query, setQuery] = useState('')
  /** Addresses Sales typed, by crmCompanyId. Empty means "use what was found". */
  const [emails, setEmails] = useState<Record<string, string>>({})
  const [name, setName] = useState('')
  const [firstSend, setFirstSend] = useState(defaultFirstSend())
  const [timezone, setTimezone] = useState('America/New_York')
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [start, setStart] = useState('09:00')
  const [end, setEnd] = useState('17:00')
  const [spacing, setSpacing] = useState('10')
  const [cap, setCap] = useState('20')
  const [reviewing, setReviewing] = useState(false)
  const [result, setResult] = useState<{ batchId: string; results: Array<{ crmCompanyId: string; ok: boolean; error: string | null; plannedAt: string | null }> } | null>(null)
  const call = useCall(() => undefined)

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= max ? p : [...p, id]))
  const nameOf = (id: string) => list.find((c) => c.crmCompanyId === id)?.companyName ?? id

  /** The address that would actually be used: what Sales typed, or what was found. */
  const emailOf = (c: Candidate) => (emails[c.crmCompanyId] ?? '').trim() || c.intendedRecipient || ''
  const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)
  /**
   * A company can go in the batch once it has a decision maker and an address.
   * Typing one is therefore enough to include a company the platform found no
   * address for — which is the whole point of the box being there.
   */
  const canPick = (c: Candidate) => Boolean(c.decisionMaker) && looksLikeEmail(emailOf(c))

  const q = query.trim().toLowerCase()
  const shown = q
    ? list.filter((c) =>
        [c.companyName, c.companyDomain ?? '', c.decisionMaker?.fullName ?? '', c.intendedRecipient ?? '', emails[c.crmCompanyId] ?? '']
          .join(' ')
          .toLowerCase()
          .includes(q),
      )
    : list
  // Anything picked then filtered out still goes in the batch, so say so
  // rather than letting the count disagree with what is on screen.
  const hiddenPicked = picked.filter((id) => !shown.some((c) => c.crmCompanyId === id)).length

  /** Addresses Sales typed for companies in the batch, and nothing else. */
  const typedRecipients = Object.fromEntries(
    picked
      .map((id) => [id, (emails[id] ?? '').trim()] as const)
      .filter(([, v]) => v.length > 0 && looksLikeEmail(v)),
  )

  const create = () =>
    void call.run('create', async () => {
      const r = (await api.post('/outreach/sequence/batches', {
        ...(name.trim() ? { name: name.trim() } : {}),
        crmCompanyIds: picked,
        // Only the ones Sales actually typed; the rest use what was found.
        ...(Object.keys(typedRecipients).length ? { recipients: typedRecipients } : {}),
        firstSendAt: new Date(firstSend).toISOString(),
        timezone: timezone.trim(),
        sendDays: days,
        sendStart: start,
        sendEnd: end,
        spacingMinutes: Number(spacing),
        dailyCap: Number(cap),
      })) as { batchId: string; results: Array<{ crmCompanyId: string; ok: boolean; error: string | null; plannedAt: string | null }> }
      setResult(r)
    })

  if (result) {
    const failed = result.results.filter((r) => !r.ok)
    return (
      <Panel title="Test batch created" subtitle="The initial emails are drafts — review and approve each one">
        <ul className="otr-list">
          {result.results.map((r) => (
            <li key={r.crmCompanyId}>
              <span className="row">
                <Chip tone={r.ok ? 'ok' : 'danger'}>{r.ok ? 'Drafted' : 'Not drafted'}</Chip>
                <span>{nameOf(r.crmCompanyId)}</span>
                {r.plannedAt && <span className="cell-dim">planned {fmtDateTime(r.plannedAt)}, once approved</span>}
              </span>
              {r.error && <span className="cell-dim">{r.error}</span>}
            </li>
          ))}
        </ul>
        {failed.length > 0 && <p className="note">{failed.length} compan{failed.length === 1 ? 'y was' : 'ies were'} not added. Nothing was sent for them.</p>}
        <div className="row">
          <Button variant="primary" onClick={() => onCreated(result.batchId)}>
            Open the batch
          </Button>
        </div>
      </Panel>
    )
  }

  return (
    <Panel
      title="New test batch"
      subtitle="Internal test inboxes only — no customer is emailed"
      actions={
        <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onCancel}>
          Back
        </Button>
      }
    >
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      {sending && sending.mode !== 'test' && (
        <p className="otr-warn">
          Sending is OFF. The batch's drafts can be created and approved, but nothing will be delivered until OUTREACH_EMAIL_MODE is "test".
        </p>
      )}

      {!reviewing ? (
        <>
          <p className="eyebrow">
            1. Companies ({picked.length} of {max} chosen)
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
                const usable = canPick(c)
                return (
                  <li key={c.crmCompanyId}>
                    <label className="otr-check">
                      <input
                        type="checkbox"
                        checked={chosen}
                        disabled={!usable || (!chosen && picked.length >= max)}
                        onChange={() => toggle(c.crmCompanyId)}
                      />
                      <span>
                        {c.companyName}
                        {c.decisionMaker && <span className="cell-dim"> · {c.decisionMaker.fullName}</span>}
                        {!c.decisionMaker && c.reason && <span className="cell-dim"> — {c.reason}</span>}
                      </span>
                    </label>
                    {/*
                      The address, always editable before the batch is made.
                      Typing one also makes a company selectable that had none,
                      which is the only way to include it at all.
                    */}
                    {c.decisionMaker && (
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
              {hiddenPicked} chosen {hiddenPicked === 1 ? 'company is' : 'companies are'} hidden by the search. {hiddenPicked === 1 ? 'It is' : 'They are'} still in the batch.
            </p>
          )}

          <p className="eyebrow row" style={{ marginTop: 'var(--s4)' }}>
            2. Schedule <InfoTip topic="schedule" />
          </p>
          <p className="note">
            Only the first send, the spacing, the sending hours and the daily cap are set here. Follow-up timing is the approved PDF timing
            (Day 9–10, 12–14, 16–18, 18–20) and is not changed — a full rehearsal takes about 20 days.
          </p>
          <div className="otr-grid">
            <label>
              <span className="field-label">Batch name (optional)</span>
              <input className="otr-input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              <span className="field-label">First emails may go from (your local time)</span>
              <input className="otr-input" type="datetime-local" value={firstSend} onChange={(e) => setFirstSend(e.target.value)} />
            </label>
            <label>
              <span className="field-label">Sending time zone</span>
              <input className="otr-input" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
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
                <span>{d}</span>
              </label>
            ))}
          </div>
          <div className="row" style={{ marginTop: 'var(--s4)' }}>
            <Button variant="primary" disabled={picked.length === 0 || days.length === 0 || !firstSend} onClick={() => setReviewing(true)}>
              Review
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="eyebrow">3. Review</p>
          <ul className="otr-list">
            <li>
              {picked.length} compan{picked.length === 1 ? 'y' : 'ies'}: {picked.map(nameOf).join(', ')}
            </li>
            <li>
              First emails from {firstSend.replace('T', ' ')} (your time), {start}–{end} {timezone}, {days.map((d) => DAY[d - 1]).join(' ')}
            </li>
            <li>
              {spacing} minutes apart, at most {cap} a day
            </li>
            <li>
              Delivered to: {sending?.testInbox ?? 'the configured internal test inbox'} ({sending?.transport === 'smtp' ? 'real mail server' : 'captured, nothing leaves the platform'})
            </li>
          </ul>
          <p className="note">
            Creating the batch drafts each company's initial email. Nothing is scheduled until Sales approves that email, and nothing ever goes
            to the customer.
          </p>
          <div className="row">
            <Button variant="quiet" onClick={() => setReviewing(false)}>
              Change
            </Button>
            <Button variant="primary" icon={FlaskConical} busy={call.busy === 'create'} onClick={create}>
              Create test batch
            </Button>
          </div>
        </>
      )}
    </Panel>
  )
}

function cellText(s: StageCell): { text: string; tone: 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'neutral'; when: string | null } {
  if (s.actionStatus) {
    const st = emailStatus(s.actionStatus, s.statusReason, true)
    const when =
      s.actionStatus === 'sent'
        ? fmtDateTime(s.sentAt)
        : s.actionStatus === 'scheduled' || s.actionStatus === 'sending'
          ? fmtDateTime(s.scheduledAt)
          : s.actionStatus === 'draft'
            ? s.scheduledAt
              ? `planned ${fmtDateTime(s.scheduledAt)}, once approved`
              : null
            : s.statusReason
    return { text: st.label, tone: st.tone, when }
  }
  const st = stepStatus(s.stageStatus)
  return { text: st.label, tone: st.tone, when: s.window ? fmtWindow(s.window) : null }
}

function BatchDetail({
  batchId,
  canOperate,
  onBack,
  onOpenCampaign,
}: {
  batchId: string
  canOperate: boolean
  onBack: () => void
  onOpenCampaign: (c: { crmCompanyId: string; companyName: string; campaignId: string }) => void
}) {
  const state = useAsync<unknown>((signal) => api.get(`/outreach/sequence/batches/${encodeURIComponent(batchId)}`, { signal }), [batchId])
  const call = useCall(state.refresh)
  const data = state.data as { batch?: BatchRow; companies?: BatchCompany[] } | null
  const batch = data?.batch ?? null
  const companies = Array.isArray(data?.companies) ? data!.companies : []

  if (state.loading && !data) return <LoadingState what="Reading the test batch" />
  if (state.error && !data) return <ErrorState error={state.error} what="The test batch could not be read" onRetry={state.refresh} />
  if (!batch) return <ErrorState error={new Error('The batch was not in the response.')} what="The test batch could not be read" onRetry={state.refresh} />

  const open = batch.status === 'running' || batch.status === 'paused'
  const post = (to: string) => call.run(to, () => api.post(`/outreach/sequence/batches/${batch.id}/${to}`, {}))

  return (
    <Panel
      title={batch.name}
      subtitle={`TEST · ${BATCH_STATUS[batch.status]?.word ?? batch.status} · ${batch.sendStart}–${batch.sendEnd} ${batch.timezone}, ${batch.sendDays
        .map((d) => DAY[d - 1])
        .join(' ')} · ${batch.spacingMinutes} min apart · at most ${batch.dailyCap}/day`}
      actions={
        <div className="row">
          <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onBack}>
            All batches
          </Button>
          {canOperate && batch.status === 'running' && (
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
              Cancel batch
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
      {companies.length === 0 ? (
        <Unset what="No company in this batch" />
      ) : (
        <div className="otr-scroll">
          <table className="otr-table otr-batch">
            <thead>
              <tr>
                <th>
                  Company <InfoTip topic="emailStatus" />
                </th>
                {COLUMNS.map((k) => {
                  const s = companies[0]!.stages.find((x) => x.stageKey === k)
                  return <th key={k}>{s ? `${s.pdfRef} ${s.label}` : k}</th>
                })}
                <th>After a reply</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => {
                const replyCells = c.stages.filter((s) => REPLY_STAGES.includes(s.stageKey) && (s.actionStatus || s.stageStatus !== 'not_applicable'))
                return (
                  <tr key={c.campaignId}>
                    <td>
                      {c.companyName ?? c.crmCompanyId}
                      <div className="cell-dim">
                        {PHASE_LABEL[c.phase] ?? c.phase}
                        {c.intendedRecipient ? ` · intended for ${c.intendedRecipient} (not emailed)` : ''}
                      </div>
                    </td>
                    {COLUMNS.map((k) => {
                      const s = c.stages.find((x) => x.stageKey === k)
                      if (!s) return <td key={k} />
                      const t = cellText(s)
                      return (
                        <td key={k}>
                          <Chip tone={t.tone}>{t.text}</Chip>
                          {t.when && <div className="cell-dim">{t.when}</div>}
                        </td>
                      )
                    })}
                    <td>
                      {replyCells.length === 0 ? (
                        <span className="cell-dim">—</span>
                      ) : (
                        replyCells.map((s) => {
                          const t = cellText(s)
                          return (
                            <div key={s.stageKey}>
                              <span className="mono">{s.pdfRef}</span> <Chip tone={t.tone}>{t.text}</Chip>
                            </div>
                          )
                        })
                      )}
                    </td>
                    <td>
                      <Button
                        size="sm"
                        icon={FileEdit}
                        onClick={() => onOpenCampaign({ crmCompanyId: c.crmCompanyId, companyName: c.companyName ?? c.crmCompanyId, campaignId: c.campaignId })}
                      >
                        Review
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
