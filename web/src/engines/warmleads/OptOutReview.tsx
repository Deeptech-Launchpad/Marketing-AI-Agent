import { useState } from 'react'
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
const KIND: Record<OptOutReviewItem['kind'], string> = { proposal: 'Opt-out', not_recorded: 'Opt-out, not recorded automatically', reconsent: 'Possible re-consent' }
/** Classifications that an approver must be warned about: a forged "unsubscribe" is most harmful for these. */
const SENSITIVE: Record<string, string> = {
  existing_customer: 'EXISTING CUSTOMER — a forged opt-out would silence a paying customer’s marketing mail.',
  active_opportunity: 'ACTIVE OPPORTUNITY — a forged opt-out would cut off a live deal from marketing mail.',
  do_not_contact: 'Already marked DO NOT CONTACT at company or domain level (that restriction stays whatever you decide here).',
}
const PAGE = 25

interface ListResponse {
  items: OptOutReviewItem[]
  /** WARM_LEADS_RECORD_OPT_OUTS: when off, nothing can be approved. */
  recordingEnabled?: boolean
  /** Proposals not yet recorded: still to be decided. */
  pendingCount?: number
  /** false only if the backstop was reached: not the whole history was read. */
  complete?: boolean
}

/**
 * The opt-outs found in replies, across every evaluation (a later failed re-check does not hide them): the masked address, the day, the
 * status and the NXT Sales activity to open. Nothing here is a raw address or message text. The SENDER OF AN EMAIL IS NOT AUTHENTICATED, so
 * nothing is ever added automatically on the strength of it: when recording is switched on, an ADMINISTRATOR approves each proposal here, after
 * confirming that the request was independently verified through a trusted contact channel (reading the unverified email is not verification).
 * The server then works the address out again from the source email - this page never sends an address.
 */
export function OptOutReview({ enabled, refreshKey, admin = false }: { enabled: boolean; refreshKey: number; admin?: boolean }) {
  const r = useAsync<ListResponse>((signal) => api.get('/warm-leads/pilot/opt-outs', { signal }), [refreshKey], { enabled })
  const [asking, setAsking] = useState<string | null>(null)
  const [verified, setVerified] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [shown, setShown] = useState(PAGE)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  if (!enabled) return null
  if (r.error) return <ErrorState error={r.error} what="The opt-outs found in replies could not be read" onRetry={r.refresh} />
  if (!r.data) return <LoadingState what="Reading the opt-outs found in replies" />
  const items = r.data.items
  const canApprove = admin && r.data.recordingEnabled === true
  const pending = r.data.pendingCount ?? items.filter((i) => i.kind === 'proposal' && i.status !== 'recorded' && i.status !== 'already_listed').length
  const key = (it: OptOutReviewItem) => `${it.crmCompanyId}|${it.activityId}`

  async function approve(it: OptOutReviewItem) {
    if (!verified) return
    setBusy(key(it))
    setNote(null)
    try {
      const out = await api.post<{ message: string }>('/warm-leads/opt-outs/approve', { crmCompanyId: it.crmCompanyId, activityId: it.activityId, confirm: true, independentlyVerified: true })
      setNote({ ok: true, text: out.message })
      setAsking(null)
      setVerified(false)
      r.refresh()
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message || 'Not approved.' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section aria-label="Opt-outs found in replies" style={{ display: 'grid', gap: 'var(--s2)' }}>
      <h4 style={{ margin: 0 }}>
        Opt-outs found in replies ({items.length}) · <span>{pending} pending</span>
      </h4>
      <p className="note" style={{ margin: 0 }}>
        {r.data.recordingEnabled
          ? 'Recording is switched on, but the sender of an email is not authenticated, so each proposal needs an administrator’s approval here — after the request has been verified independently through a trusted contact channel.'
          : 'With recording switched off, nothing is written to the suppression list: these are only proposals. Even with recording switched on, nobody is suppressed automatically: an administrator approves each one.'}
      </p>
      {r.data.complete === false && (
        <p className="note note--caveat" role="alert" style={{ margin: 0 }}>
          The list is NOT complete: more evaluations exist than could be read, so some proposals are missing here. Do not treat this list as everything pending.
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
            {items.slice(0, shown).map((it) => {
              const approvable = canApprove && it.kind === 'proposal' && (it.status === 'awaiting_approval' || it.status === 'dry_run') && Boolean(it.fingerprint)
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
                  {approvable &&
                    (asking === key(it) ? (
                      <div style={{ display: 'grid', gap: 6 }}>
                        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                          <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />
                          <span>
                            I confirm this request was verified <strong>independently through a trusted contact channel</strong> (for example, by contacting the person at a known number or address). Reading the email in NXT Sales is not verification.
                          </span>
                        </label>
                        <span style={{ display: 'inline-flex', gap: 6 }}>
                          <Button variant="primary" busy={busy === key(it)} disabled={!verified} onClick={() => approve(it)}>
                            Yes — add {it.masked ?? 'this address'} to the suppression list
                          </Button>
                          <Button
                            onClick={() => {
                              setAsking(null)
                              setVerified(false)
                            }}
                          >
                            Cancel
                          </Button>
                        </span>
                      </div>
                    ) : (
                      <span>
                        <Button
                          onClick={() => {
                            setAsking(key(it))
                            setVerified(false)
                          }}
                        >
                          Approve…
                        </Button>
                      </span>
                    ))}
                  {canApprove && it.kind === 'proposal' && (it.status === 'awaiting_approval' || it.status === 'dry_run') && !it.fingerprint && (
                    <p className="note" style={{ margin: 0 }}>This older proposal cannot be approved: the company has to be evaluated again first.</p>
                  )}
                </li>
              )
            })}
          </ul>
          {items.length > shown && (
            <span>
              <Button onClick={() => setShown(shown + PAGE)}>Show more ({items.length - shown} remaining)</Button>
            </span>
          )}
        </>
      )}
    </section>
  )
}
