import { useEffect, useState } from 'react'
import { api } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { Button } from '../../components/ui/primitives'
import { ErrorState, LoadingState } from '../../components/ui/states'
import { CLASS } from './labels'
import type { OptOutReviewItem } from './types'

/** What each status of an opt-out line means, in words a reviewer can act on. */
export const OPT_OUT_STATUS: Record<string, string> = {
  dry_run: 'Dry run — nothing was written',
  awaiting_approval: 'Waiting for a person to approve — nothing was written',
  recorded: 'Added to the suppression list',
  already_listed: 'Already on the suppression list',
  needs_person: 'A person decides',
  failed: 'Could not be added — tried again',
  for_review: 'Possible re-consent — a person reviews',
}
const KIND: Record<OptOutReviewItem['kind'], string> = { proposal: 'Opt-out', not_recorded: 'Opt-out, not recorded automatically', reconsent: 'Possible re-consent', omitted: 'Not listed' }
/** Classifications that an approver must be warned about: a forged "unsubscribe" is most harmful for these. */
const SENSITIVE: Record<string, string> = {
  existing_customer: 'EXISTING CUSTOMER — a forged opt-out would silence a paying customer’s marketing mail.',
  active_opportunity: 'ACTIVE OPPORTUNITY — a forged opt-out would cut off a live deal from marketing mail.',
  do_not_contact: 'Already marked DO NOT CONTACT at company or domain level (that restriction stays whatever you decide here).',
}
/** Why a pending proposal cannot be approved right now (the browser is told a code, never the fingerprint). */
const BLOCKED: Record<string, string> = {
  key_not_configured: 'Approval is blocked: the server’s opt-out fingerprint key is not configured, so a proposal cannot be checked.',
  key_changed: 'Re-review needed: the fingerprint key was changed after this proposal was made, so it can no longer be checked. Evaluate the company again and review the NEW proposal.',
  no_fingerprint: 'This older proposal cannot be approved: the company has to be evaluated again first.',
}
/** How the request was verified, through a channel that is NOT the (unauthenticated) email itself. The codes are the server's; nothing is free text. */
export const VERIFICATION_METHODS: Array<{ value: string; label: string }> = [
  { value: 'phone_call_known_number', label: 'Phone call to a number we already had for this contact' },
  { value: 'email_to_address_on_file', label: 'A NEW email to the address on file for this contact (not a reply to this email)' },
  { value: 'account_owner_confirmed', label: 'The account owner in NXT Sales confirmed it' },
  { value: 'meeting_or_video_call', label: 'In a meeting or video call' },
  { value: 'other_trusted_channel', label: 'Another trusted channel (never this email itself)' },
]
const STEP = 50
/** The exact address stays on screen only briefly, and only in this component's memory. */
const REVEAL_SECONDS = 120

interface Revealed {
  key: string
  address: string
  notice: string
}

interface ListResponse {
  items: OptOutReviewItem[]
  /** WARM_LEADS_RECORD_OPT_OUTS: when off, nothing can be approved. */
  recordingEnabled?: boolean
  /** Lines in total (the response carries only the first `shown`). */
  total?: number
  shown?: number
  /** Proposals not yet recorded, including those counted but not listed. */
  pendingCount?: number
  /** Found by the checks but not listed (per-check caps): counted, never silently dropped. */
  omitted?: { proposals: number; notRecorded: number }
  /** false only if the backstop was reached: not the whole history was read. */
  complete?: boolean
}

/**
 * The opt-outs found in replies, across every evaluation (a later failed re-check does not hide them): the masked address, the day, the
 * status and the NXT Sales activity to open. Nothing here is a raw address, a fingerprint or message text. The SENDER OF AN EMAIL IS NOT
 * AUTHENTICATED, so nothing is ever added automatically on the strength of it: when recording is switched on, an ADMINISTRATOR approves each
 * proposal here, after confirming that the request was independently verified through a trusted contact channel (reading the unverified email is
 * not verification). With recording switched OFF the list is read-only. The server then works the address out again from the source email - this
 * page never sends an address.
 */
export function OptOutReview({ enabled, refreshKey, admin = false }: { enabled: boolean; refreshKey: number; admin?: boolean }) {
  const [limit, setLimit] = useState(STEP)
  const r = useAsync<ListResponse>((signal) => api.get(`/warm-leads/pilot/opt-outs?limit=${limit}`, { signal }), [refreshKey, limit], { enabled })
  const [asking, setAsking] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [method, setMethod] = useState('')
  const [shown, setShown] = useState<Revealed | null>(null)
  const [revealing, setRevealing] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  // the exact address is never kept: it disappears after two minutes, and whenever the list reloads or the form closes
  useEffect(() => {
    if (!shown) return undefined
    const t = setTimeout(() => setShown(null), REVEAL_SECONDS * 1000)
    return () => clearTimeout(t)
  }, [shown])
  useEffect(() => setShown(null), [refreshKey])
  if (!enabled) return null
  if (r.error) return <ErrorState error={r.error} what="The opt-outs found in replies could not be read" onRetry={r.refresh} />
  if (!r.data) return <LoadingState what="Reading the opt-outs found in replies" />
  const items = r.data.items
  const recording = r.data.recordingEnabled === true
  const total = r.data.total ?? items.length
  const pending = r.data.pendingCount ?? items.filter((i) => i.kind === 'proposal' && i.status !== 'recorded' && i.status !== 'already_listed').length
  const om = r.data.omitted
  const key = (it: OptOutReviewItem) => `${it.crmCompanyId}|${it.activityId}`

  async function approve(it: OptOutReviewItem) {
    if (!verified || !method) return
    setBusy(key(it))
    setNote(null)
    try {
      const out = await api.post<{ message: string }>('/warm-leads/opt-outs/approve', { crmCompanyId: it.crmCompanyId, activityId: it.activityId, confirm: true, independentlyVerified: true, verificationMethod: method })
      setNote({ ok: true, text: out.message })
      setAsking(null)
      setVerified(false)
      setMethod('')
      setShown(null)
      r.refresh()
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message || 'Not approved.' })
    } finally {
      setBusy(null)
    }
  }

  async function reveal(it: OptOutReviewItem) {
    setRevealing(key(it))
    setNote(null)
    try {
      const out = await api.post<{ address: string; notice: string }>('/warm-leads/opt-outs/reveal', { crmCompanyId: it.crmCompanyId, activityId: it.activityId })
      setShown({ key: key(it), address: out.address, notice: out.notice })
    } catch (err) {
      setShown(null)
      setNote({ ok: false, text: (err as Error).message || 'The address could not be shown.' })
    } finally {
      setRevealing(null)
    }
  }

  function closeForm() {
    setAsking(null)
    setVerified(false)
    setMethod('')
    setShown(null)
  }

  return (
    <section aria-label="Opt-outs found in replies" style={{ display: 'grid', gap: 'var(--s2)' }}>
      <h4 style={{ margin: 0 }}>
        Opt-outs found in replies ({total}) · <span>{pending} pending</span>
      </h4>
      <p className="note" style={{ margin: 0 }}>
        {recording
          ? 'Recording is switched on, but the sender of an email is not authenticated, so each proposal needs an administrator’s approval here — after the request has been verified independently through a trusted contact channel.'
          : 'With recording switched off, nothing is written to the suppression list: these are only proposals. Even with recording switched on, nobody is suppressed automatically: an administrator approves each one.'}
      </p>
      {!recording && admin && (
        <p className="note note--caveat" style={{ margin: 0 }}>
          <strong>Approval is disabled</strong> because recording is switched OFF on this server (WARM_LEADS_RECORD_OPT_OUTS). This list is read-only: nothing can be added to the suppression list from this screen. Turning recording on needs the owner’s separate approval.
        </p>
      )}
      {r.data.complete === false && (
        <p className="note note--caveat" role="alert" style={{ margin: 0 }}>
          The list is NOT complete: more evaluations exist than could be read, so some proposals are missing here. Do not treat this list as everything pending.
        </p>
      )}
      {om && (om.proposals > 0 || om.notRecorded > 0) && (
        <p className="note note--caveat" style={{ margin: 0 }}>
          Not listed individually: {om.proposals} further opt-out sender(s) and {om.notRecorded} further opt-out message(s) were found but are above the per-check limit. They are counted here — nothing was dropped silently. Handle the listed ones, then check those companies again to see more.
        </p>
      )}
      {note && (
        <p className={note.ok ? 'note' : 'note note--caveat'} role={note.ok ? 'status' : 'alert'} style={{ margin: 0 }}>
          {note.text}
        </p>
      )}
      {items.length === 0 ? (
        <p className="note" style={{ margin: 0 }}>No opt-out was found in any reply.</p>
      ) : (
        <>
          <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 'var(--s2)' }}>
            {items.map((it) => {
              const pendingProposal = it.kind === 'proposal' && (it.status === 'awaiting_approval' || it.status === 'dry_run')
              const approvable = admin && recording && pendingProposal && it.approvable === true
              const blocked = admin && recording && pendingProposal && it.approvable !== true && it.approvalBlockedReason ? BLOCKED[it.approvalBlockedReason] : undefined
              const klass = it.companyClassification ? (CLASS[it.companyClassification]?.label ?? it.companyClassification) : null
              const warning = it.kind === 'proposal' && it.companyClassification ? SENSITIVE[it.companyClassification] : undefined
              return (
                <li key={`${it.evaluationId}-${it.kind}-${it.activityId ?? it.masked ?? it.summary}`} style={{ border: '1px solid var(--border, #ccc)', borderRadius: 6, padding: 'var(--s2)', display: 'grid', gap: 4 }}>
                  <div>
                    <strong>{it.companyName ?? it.crmCompanyId}</strong>
                    {klass && <> · company is currently: <span>{klass}</span></>}
                  </div>
                  <div>
                    {KIND[it.kind]}: {OPT_OUT_STATUS[it.status] ?? it.status}
                    {it.masked && <> · <span className="tnum">{it.masked}</span></>}
                    {it.receivedOn && <> · received {it.receivedOn}</>}
                    {it.activityId && (
                      <>
                        {' '}
                        · NXT Sales activity <code>{it.activityId}</code>
                      </>
                    )}
                    {it.approvedBy && <> · approved by {it.approvedBy}</>}
                  </div>
                  {it.kind === 'proposal' && (
                    <p className="note note--caveat" style={{ margin: 0 }}>
                      <strong>SENDER NOT AUTHENTICATED</strong> — NXT Sales stores the From line as received; anyone can forge it. This proposal alone proves nothing.
                    </p>
                  )}
                  {warning && (
                    <p className="note note--caveat" role="alert" style={{ margin: 0 }}>
                      <strong>Warning:</strong> {warning}
                    </p>
                  )}
                  {it.kind === 'proposal' && it.reason && <p style={{ margin: 0 }}>Why this was proposed: {it.reason}</p>}
                  {blocked && <p className="note" style={{ margin: 0 }}>{blocked}</p>}
                  {approvable &&
                    (asking === key(it) ? (
                      <div style={{ display: 'grid', gap: 6 }}>
                        <div style={{ display: 'grid', gap: 4 }}>
                          <span>
                            <Button busy={revealing === key(it)} onClick={() => reveal(it)}>
                              Show the exact address
                            </Button>
                          </span>
                          {shown && shown.key === key(it) && (
                            <p className="note note--caveat" role="status" style={{ margin: 0 }}>
                              Exact sender address: <code className="tnum">{shown.address}</code> — <strong>from an unauthenticated From line.</strong> {shown.notice} (Shown for {REVEAL_SECONDS / 60} minutes at most; this view is recorded in the audit log, without the address.){' '}
                              <Button onClick={() => setShown(null)}>Hide</Button>
                            </p>
                          )}
                        </div>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
                          <span>
                            I confirm this request was verified <strong>independently through a trusted contact channel</strong> (for example, by contacting the person at a known number or address). Reading the email in NXT Sales is not verification.
                          </span>
                        </label>
                        <label style={{ display: 'grid', gap: 2 }}>
                          <span>How did you verify it? (recorded with your approval)</span>
                          <select value={method} onChange={(e) => setMethod(e.target.value)} aria-label="How the request was verified">
                            <option value="">Choose how it was verified…</option>
                            {VERIFICATION_METHODS.map((m) => (
                              <option key={m.value} value={m.value}>
                                {m.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <Button variant="primary" busy={busy === key(it)} disabled={!verified || !method} onClick={() => approve(it)}>
                            Yes — add {it.masked ?? 'this address'} to the suppression list
                          </Button>
                          <Button onClick={closeForm}>Cancel</Button>
                        </span>
                      </div>
                    ) : (
                      <span>
                        <Button
                          onClick={() => {
                            setAsking(key(it))
                            setVerified(false)
                            setMethod('')
                            setShown(null)
                          }}
                        >
                          Approve…
                        </Button>
                      </span>
                    ))}
                </li>
              )
            })}
          </ul>
          {total > items.length && (
            <span>
              <Button onClick={() => setLimit(limit + STEP)}>Show more ({total - items.length} remaining)</Button>
            </span>
          )}
        </>
      )}
    </section>
  )
}
