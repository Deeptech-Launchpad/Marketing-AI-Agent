import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CalendarClock, CheckCircle2, Copy, FlaskConical, Mail, RotateCcw, Save, ThumbsUp, XCircle } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Field, StatusBadge, Unset, toUiStatus } from '../../components/ui/primitives'
import { Drawer } from '../../components/ui/Evidence'
import { asPlainText, buildGmailCompose, buildMailto, copyText } from './mailto'
import { useCall } from './useCall'
import { InfoTip } from './InfoTip'
import { emailStatus } from './status'
import { APPROVED_UNSENT, fmtDateTime, fmtWindow, type CompanySequence, type Draft, type SendAttempt, type SendingStatus, type Version } from './types'

// THE REVIEW SCREEN FOR ONE EMAIL.
//
// Everything Sales needs to decide on it, in one place: who it goes to, the
// words (editable), which approved template and version it came from, what
// was personalised and from which verified fact, the intent signals that were
// considered and the one (if any) that was used, the values only Sales can
// supply, and the checklist that decides whether it may be approved.
//
// There is no control that emails a customer. An approved email is copied or
// opened in the person's own mail client, sent from there, and marked sent.
//
// TEST MODE (2026-09-28): in a test-batch campaign, an approved email is
// scheduled and delivered by the test sender to the INTERNAL test inbox only,
// and "Test email to my inbox" previews any draft to the reviewer's own
// internal address. Both are refused by the backend unless sending is in test
// mode and the address is on the internal allow-list.

const ATTEMPT_WORD: Record<SendAttempt['status'], string> = {
  accepted: 'Delivered',
  failed: 'Failed',
  blocked: 'Blocked',
}

const SKU_SLOTS = [0, 1, 2, 3, 4]

export function DraftEditor({
  draft,
  view,
  open,
  onClose,
  onChanged,
  canOperate,
  canApprove,
  sending = null,
}: {
  draft: Draft | null
  view: CompanySequence
  open: boolean
  onClose: () => void
  onChanged: () => void
  canOperate: boolean
  canApprove: boolean
  sending?: SendingStatus | null
}) {
  const call = useCall(onChanged)
  const [preview, setPreview] = useState<{ status: string; to: string[]; error: string | null } | null>(null)
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [client, setClient] = useState('')
  const [skus, setSkus] = useState<string[]>(['', '', '', '', ''])
  const [x, setX] = useState<string>('')
  const [recipient, setRecipient] = useState('')
  const [product, setProduct] = useState('')
  const [category, setCategory] = useState('')
  const [rejectReason, setRejectReason] = useState('')
  const [sentAt, setSentAt] = useState('')
  /** null = not tried, true = on the clipboard, false = it did not work. */
  const [copied, setCopied] = useState<boolean | null>(null)

  // Reset the form whenever a different draft, or a new revision of it, opens.
  useEffect(() => {
    if (!draft) return
    setSubject(draft.subject ?? '')
    setBody(draft.body ?? '')
    setClient(draft.inputs?.clientCompanyName ?? '')
    const s = draft.inputs?.skus ?? []
    setSkus(SKU_SLOTS.map((i) => s[i] ?? ''))
    setX(typeof draft.inputs?.xOf5 === 'number' ? String(draft.inputs.xOf5) : '')
    setRecipient(draft.recipient ?? '')
    setProduct(draft.inputs?.product ?? '')
    setCategory(draft.inputs?.productCategory ?? '')
    setRejectReason('')
    setSentAt('')
    // null, not false: false means "the copy failed" and shows a warning.
    setCopied(null)
    setPreview(null)
    call.clearError()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.actionId, draft?.revision, draft?.status])

  const p = draft?.personalization ?? null
  const unresolved = useMemo(() => p?.unresolved ?? [], [p])

  if (!draft) return null

  const id = draft.actionId
  const isTest = Boolean(view.campaign?.isTest)
  const isDraft = draft.status === 'draft'
  // Approved and not yet gone: for a real email, waiting for a person to send
  // it; for a test email, scheduled, unscheduled or failed.
  const isApproved = APPROVED_UNSENT.includes(draft.status)
  const editable = canOperate && (isDraft || isApproved)
  const attempts = draft.attempts ?? []
  const testMode = sending?.mode === 'test'
  const statusWord = emailStatus(draft.status, draft.statusReason, isTest).label
  const dirty = subject !== (draft.subject ?? '') || body !== (draft.body ?? '')
  const gates = draft.gates
  // The placeholder check as it stands NOW, from the live checklist. The old
  // warning read the snapshot taken when the draft was first written, so it
  // never cleared after Sales filled a gap — "cannot be approved" sat above
  // an enabled Approve button (2026-10-06). It also names the real tokens.
  const placeholderCheck = gates?.items.find((i) => i.key === 'placeholders') ?? null
  const signals = view.facts.signals ?? []
  const used = new Set(p?.signalsUsed ?? [])
  const considered = new Set(p?.signalsConsidered ?? [])
  const aiLine = p?.aiLine ?? null
  const post = (path: string, payload?: unknown) => api.post(`/outreach/sequence${path}`, payload ?? {})

  const saveInputs = () => {
    const patch: Record<string, unknown> = {}
    if (draft.requiredInputs.includes('clientCompanyName')) patch.clientCompanyName = client.trim() || null
    if (draft.requiredInputs.includes('skus')) {
      const list = skus.map((s) => s.trim())
      patch.skus = list.every((s) => !s) ? null : list
    }
    if (draft.requiredInputs.includes('xOf5')) patch.xOf5 = x === '' ? null : Number(x)
    if (unresolved.includes('product') || draft.inputs?.product) patch.product = product.trim() || null
    if (unresolved.includes('productCategory') || draft.inputs?.productCategory) patch.productCategory = category.trim() || null
    if (recipient.trim() !== (draft.recipient ?? '')) patch.recipientEmail = recipient.trim() || null
    return call.run('inputs', () => post(`/actions/${id}/inputs`, patch))
  }

  // Reports what actually happened. The clipboard API does not exist over
  // plain HTTP, so claiming success without checking would be a lie — and was.
  const copy = async () => setCopied(await copyText(asPlainText(draft.recipient, draft.subject, draft.body)))

  /** Saves just the address, so it can be changed without touching anything else. */
  const saveRecipient = () =>
    call.run('recipient', () => post(`/actions/${id}/inputs`, { recipientEmail: recipient.trim() || null }))

  /** Where the address on record came from, in words. */
  const recipientSourceNote =
    draft.recipientSource === 'sales_entered'
      ? 'entered by Sales'
      : draft.recipientSource === 'company_mailbox'
        ? `company mailbox — ${view.facts.decisionMaker?.fullName ?? 'the decision maker'} has no direct email; from ${
            view.facts.decisionMaker?.companyContactEmail?.sourceLabel ?? 'a verified public source'
          }`
        : 'from Decision Makers'

  const attested = (key: string) => draft.attestations.find((a) => a.key === key) ?? null
  // The recipient is no longer counted here: it has its own field and its own
  // Save button up beside "Goes to", where somebody looking for it will look.
  const needsValues = draft.requiredInputs.length > 0 || unresolved.includes('product') || unresolved.includes('productCategory')

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={720}
      title={`${draft.pdfRef} ${draft.label}`}
      subtitle={
        <span className="row">
          <StatusBadge status={toUiStatus(draft.status)} label={statusWord} size="sm" />
          {isTest && <Chip tone="warn">Test run</Chip>}
          <InfoTip topic="emailStatus" />
          {draft.edited && <Chip tone="info">Edited by Sales</Chip>}
          <Chip>Revision {draft.revision}</Chip>
        </span>
      }
    >
      <div className="otr-ed">
        {call.error && (
          <p className="otr-err" role="alert">
            <AlertTriangle size={13} aria-hidden="true" /> {call.error}
          </p>
        )}

        {/* ── Who and where ─────────────────────────────────────────── */}
        <section className="otr-ed__block">
          <Field label="Company" value={view.facts.companyName} />
          <Field
            label="Decision maker"
            value={draft.contactName ? `${draft.contactName}${draft.contactTitle ? ` · ${draft.contactTitle}` : ''}` : <Unset />}
          />
          {/*
            WHERE THIS EMAIL GOES — ALWAYS SALES'S TO DECIDE.

            The platform fills this in when it can: the decision maker's own
            address, or a verified company mailbox when they have none. But it
            often cannot, and Sales may simply know better — so the address is
            editable here rather than fixed, including after the platform has
            filled it and after the draft has been approved.

            Changing it sends an approved draft back for re-approval, because
            an approval is an approval to write to a particular person.
          */}
          <Field
            label="Goes to"
            value={
              editable ? (
                <span className="otr-goesto">
                  <span className="otr-goesto__row">
                    <input
                      className="otr-input otr-goesto__input"
                      type="email"
                      value={recipient}
                      placeholder="name@company.com"
                      aria-label="Recipient email address"
                      onChange={(e) => setRecipient(e.target.value)}
                    />
                    <Button
                      size="sm"
                      icon={Save}
                      busy={call.busy === 'recipient'}
                      // Saving reloads the draft, which would drop unsaved
                      // text edits (2026-10-06).
                      disabled={recipient.trim() === (draft.recipient ?? '') || dirty}
                      title={dirty ? 'Save your changes first' : undefined}
                      onClick={() => void saveRecipient()}
                    >
                      Save
                    </Button>
                    <InfoTip topic="recipient" />
                  </span>
                  <span className="cell-dim otr-goesto__note">
                    {recipient.trim() !== (draft.recipient ?? '')
                      ? 'Not saved yet.'
                      : draft.recipient
                        ? recipientSourceNote
                        : 'Nothing was found automatically. Paste the address you want this to go to.'}
                  </span>
                </span>
              ) : draft.recipient ? (
                <span>
                  <InfoTip topic="recipient" /> {draft.recipient} <span className="cell-dim">({recipientSourceNote})</span>
                </span>
              ) : (
                <Unset what="No email address on record" />
              )
            }
          />
          <Field
            label="Approved template"
            value={`${draft.pdfRef} ${draft.label}${draft.version ? ` · ${draft.version.toUpperCase()}` : ''}${p?.templateSet ? ` · ${p.templateSet}` : ''}`}
          />
          {(draft.dueStartAt || draft.dueEndAt) && (
            <Field label="Due" value={fmtWindow({ start: draft.dueStartAt ?? draft.dueEndAt!, end: draft.dueEndAt ?? draft.dueStartAt! })} />
          )}
          {draft.approvedAt && <Field label="Approved" value={fmtDateTime(draft.approvedAt)} />}
          {draft.scheduledAt && <Field label="Scheduled (test)" value={fmtDateTime(draft.scheduledAt)} />}
          {draft.sentAt && (
            <Field label={draft.sentVia === 'platform_test' ? 'Sent (test, internal inbox)' : 'Marked sent'} value={fmtDateTime(draft.sentAt)} />
          )}
          {draft.statusReason && draft.status !== 'draft' && <p className="note">{draft.statusReason}</p>}
        </section>

        {/* ── Version (initial email only) ──────────────────────────── */}
        {draft.stageKey === 'initial' && draft.version && editable && (
          <section className="otr-ed__block">
            <p className="eyebrow row">
              Version <InfoTip topic="versions" />
            </p>
            <div className="otr-seg" role="group" aria-label="Initial email version">
              {(['v1', 'v2', 'v3'] as Version[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  className="otr-seg__btn"
                  aria-pressed={draft.version === v}
                  disabled={Boolean(call.busy) || draft.version === v}
                  onClick={() => void call.run('version', () => post(`/actions/${id}/version`, { version: v }))}
                >
                  {v.toUpperCase()}
                </button>
              ))}
            </div>
            <p className="note">
              {view.campaign?.versionSource === 'sales_override' ? 'Chosen by Sales.' : 'Assigned by rotation across prospects.'} Switching
              regenerates the draft from that version and clears the test confirmation, because each version states it differently.
            </p>
          </section>
        )}

        {/* ── The email ─────────────────────────────────────────────── */}
        <section className="otr-ed__block">
          <label className="field-label" htmlFor={`subj-${id}`}>
            Subject
          </label>
          {draft.subject === null && !editable ? (
            <Unset what="Sent in the same thread as the initial email" />
          ) : (
            <input
              id={`subj-${id}`}
              className="otr-input"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              readOnly={!editable}
            />
          )}
          <label className="field-label" htmlFor={`body-${id}`} style={{ marginTop: 'var(--s3)' }}>
            Body
          </label>
          <textarea
            id={`body-${id}`}
            className="textarea otr-body"
            rows={18}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            readOnly={!editable}
          />
          {editable && (
            <div className="row" style={{ marginTop: 'var(--s2)' }}>
              <Button
                icon={Save}
                size="sm"
                disabled={!dirty}
                busy={call.busy === 'edit'}
                onClick={() => void call.run('edit', () => post(`/actions/${id}/edit`, { subject: subject || null, body }))}
              >
                Save changes
              </Button>
              {dirty && (
                <Button size="sm" variant="quiet" onClick={() => { setSubject(draft.subject ?? ''); setBody(draft.body) }}>
                  Discard changes
                </Button>
              )}
              {isApproved && <span className="cell-dim">Saving a change returns the email to review.</span>}
            </div>
          )}
          {placeholderCheck && !placeholderCheck.ok && (
            <p className="otr-warn">
              <AlertTriangle size={12} aria-hidden="true" /> {placeholderCheck.detail ?? 'A placeholder is still unfilled.'} The email
              cannot be approved while a placeholder remains.
            </p>
          )}
          {draft.mentionsExpo && editable && (gates?.warnings ?? []).some((w) => /expo/i.test(w)) && (
            <Button size="sm" variant="quiet" busy={call.busy === 'expo'} onClick={() => void call.run('expo', () => post(`/actions/${id}/remove-expo`))}>
              Remove the expo paragraph
            </Button>
          )}
        </section>

        {/* ── What was filled in, and from what ─────────────────────── */}
        <section className="otr-ed__block">
          <p className="eyebrow">What was filled in</p>
          {/*
            Drafts prepared before 2026-09-30 may still carry an AI line, so it
            is still shown when one is there — a reviewer must be able to see
            every sentence in front of them. Nothing prepared since has one.
          */}
          {aiLine?.status === 'added' && aiLine.text ? (
            <div className="otr-ai">
              <Chip tone="warn">AI-added line — from an older draft</Chip>
              <p className="otr-ai__text">{aiLine.text}</p>
              <p className="cell-dim">
                Based on: {aiLine.factIds.join(', ')}. Emails prepared now carry no AI-written line; delete this one if you
                do not want it.
              </p>
            </div>
          ) : (
            <p className="note">
              Every sentence is the approved copy. The only things filled in are the values below — the company, the
              product and what Sales entered.
            </p>
          )}
          {(p?.resolution ?? []).length > 0 && (
            <table className="otr-table">
              <thead>
                <tr>
                  <th>Placeholder</th>
                  <th>Filled with</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {(p?.resolution ?? []).map((r) => (
                  <tr key={r.placeholder}>
                    <td className="mono">{r.placeholder}</td>
                    <td>{r.value ?? <Unset what="Not filled" />}</td>
                    <td className="cell-dim">{r.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {/* ── Intent signals ────────────────────────────────────────── */}
        <section className="otr-ed__block">
          <p className="eyebrow">Intent signals</p>
          {signals.length === 0 ? (
            <p className="note">No active, verified intent signal for this company. None was used, and none was assumed.</p>
          ) : (
            <ul className="otr-list">
              {signals.map((s) => {
                const sid = `signal.${s.id}`
                return (
                  <li key={s.id}>
                    <span className="row">
                      <Chip tone={used.has(sid) ? 'accent' : 'neutral'}>{used.has(sid) ? 'Used' : considered.has(sid) ? 'Considered' : 'Available'}</Chip>
                      <span className="cell-dim">
                        {s.category.replace(/_/g, ' ')}
                        {s.observedAt ? ` · ${s.observedAt.slice(0, 10)}` : ''}
                      </span>
                    </span>
                    <span>{s.summary}</span>
                    {s.sourceUrl && (
                      <a className="cell-link" href={s.sourceUrl} target="_blank" rel="noreferrer noopener">
                        Source
                      </a>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        {/* ── Values only Sales can supply ──────────────────────────── */}
        {editable && needsValues && (
          <section className="otr-ed__block">
            <p className="eyebrow">Values from Sales</p>
            <p className="note">These are never filled by the AI — they come from your own test, report or records.</p>
            <div className="otr-grid">
              {draft.requiredInputs.includes('clientCompanyName') && (
                <label>
                  <span className="field-label">Client Company Name</span>
                  <input className="otr-input" value={client} onChange={(e) => setClient(e.target.value)} />
                </label>
              )}
              {(unresolved.includes('product') || draft.inputs?.product) && (
                <label>
                  <span className="field-label">Product</span>
                  <input className="otr-input" value={product} onChange={(e) => setProduct(e.target.value)} />
                </label>
              )}
              {(unresolved.includes('productCategory') || draft.inputs?.productCategory) && (
                <label>
                  <span className="field-label">Product category</span>
                  <input className="otr-input" value={category} onChange={(e) => setCategory(e.target.value)} />
                </label>
              )}
              {draft.requiredInputs.includes('xOf5') && (
                <label>
                  <span className="field-label">X of 5 (from your report)</span>
                  <select className="otr-input" value={x} onChange={(e) => setX(e.target.value)}>
                    <option value="">Not entered</option>
                    {[0, 1, 2, 3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {draft.requiredInputs.includes('skus') && (
              <div className="otr-grid" style={{ marginTop: 'var(--s3)' }}>
                {SKU_SLOTS.map((i) => (
                  <label key={i}>
                    <span className="field-label">SKU {i + 1}</span>
                    <input
                      className="otr-input"
                      value={skus[i]}
                      onChange={(e) => setSkus((prev) => prev.map((v, j) => (j === i ? e.target.value : v)))}
                    />
                  </label>
                ))}
              </div>
            )}
            <div className="row" style={{ marginTop: 'var(--s3)' }}>
              {/* Saving values reloads the draft from the server, which
                  silently discarded any typed but unsaved changes to the
                  subject or body (2026-10-06). */}
              <Button
                icon={Save}
                size="sm"
                busy={call.busy === 'inputs'}
                disabled={dirty}
                title={dirty ? 'Save your changes to the email first' : undefined}
                onClick={() => void saveInputs()}
              >
                Save values
              </Button>
            </div>
          </section>
        )}

        {/* ── Confirmations only Sales can make ─────────────────────── */}
        {draft.attestationDefs.length > 0 && (
          <section className="otr-ed__block">
            <p className="eyebrow">Sales confirmation</p>
            {draft.attestationDefs.map((d) => {
              const a = attested(d.key)
              return (
                <label key={d.key} className="otr-check">
                  <input
                    type="checkbox"
                    checked={Boolean(a)}
                    disabled={!editable || Boolean(call.busy)}
                    onChange={(e) => void call.run(`attest-${d.key}`, () => post(`/actions/${id}/attest`, { key: d.key, confirmed: e.target.checked }))}
                  />
                  <span>
                    {d.statement}
                    {d.maxAgeDays ? <span className="cell-dim"> (valid for {d.maxAgeDays} days)</span> : null}
                    {a && <span className="cell-dim"> — confirmed {fmtDateTime(a.at)}</span>}
                  </span>
                </label>
              )
            })}
          </section>
        )}

        {/* ── The checklist ─────────────────────────────────────────── */}
        {gates && (
          <section className="otr-ed__block">
            <p className="eyebrow row">
              Before approval <InfoTip topic="checklist" />
            </p>
            <ul className="otr-gates">
              {gates.items.map((g) => (
                <li key={g.key} className={g.ok ? 'is-ok' : 'is-bad'}>
                  {g.ok ? <CheckCircle2 size={13} aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}
                  <span>
                    {g.label}
                    {g.detail && !g.ok ? <span className="cell-dim"> — {g.detail}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
            {gates.warnings.map((w, i) => (
              <p key={i} className="otr-warn">
                <AlertTriangle size={12} aria-hidden="true" /> {w}
              </p>
            ))}
          </section>
        )}

        {/* ── Decisions ─────────────────────────────────────────────── */}
        {isDraft && canApprove && (
          <section className="otr-ed__block">
            <p className="eyebrow row">
              Your decision <InfoTip topic="approval" />
            </p>
            <div className="row">
              <Button
                icon={ThumbsUp}
                variant="primary"
                disabled={!gates?.ok || dirty}
                title={dirty ? 'Save your changes first' : gates?.ok ? undefined : 'Complete the checklist first'}
                busy={call.busy === 'approve'}
                onClick={() => void call.run('approve', () => post(`/actions/${id}/approve`))}
              >
                Approve
              </Button>
            </div>
            {isTest && (
              <p className="note">
                TEST campaign: approving puts this email on the test schedule. It goes only to the internal test inbox, never to the customer.
              </p>
            )}
            <label className="field-label" htmlFor={`rej-${id}`} style={{ marginTop: 'var(--s3)' }}>
              Reason for rejecting (optional)
            </label>
            <textarea id={`rej-${id}`} className="textarea" rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            <div className="row" style={{ marginTop: 'var(--s2)' }}>
              <Button
                icon={RotateCcw}
                size="sm"
                busy={call.busy === 'regen'}
                onClick={() => void call.run('regen', () => post(`/actions/${id}/reject`, { reason: rejectReason, regenerate: true }))}
              >
                Reject &amp; regenerate
              </Button>
              <Button
                icon={XCircle}
                size="sm"
                variant="danger"
                busy={call.busy === 'reject'}
                onClick={() => void call.run('reject', () => post(`/actions/${id}/reject`, { reason: rejectReason, regenerate: false }))}
              >
                Reject
              </Button>
            </div>
          </section>
        )}
        {isDraft && !canApprove && <p className="note">Approval is made by someone with approval permission.</p>}

        {/* ── TEST campaign: the test sender, never the customer ───── */}
        {isTest && isApproved && (
          <section className="otr-ed__block otr-ed__send">
            {draft.status === 'scheduled' && (
              <p className="note">
                <CalendarClock size={12} aria-hidden="true" /> Scheduled for {fmtDateTime(draft.scheduledAt)}. The test sender delivers it to the
                internal test inbox{sending?.testInbox ? ` (${sending.testInbox})` : ''} at that time. {view.campaign?.recipientEmail ?? 'The customer'} is
                not emailed.
              </p>
            )}
            {draft.status === 'failed' && (
              <p className="otr-err" role="alert">
                <AlertTriangle size={13} aria-hidden="true" /> The test send did not go: {draft.statusReason ?? 'no reason was recorded'}
              </p>
            )}
            {draft.status === 'ready_to_send' && (
              <p className="note">{draft.statusReason ?? 'Approved, but not on the test schedule.'}</p>
            )}
            {canOperate && draft.status !== 'scheduled' && (
              <div className="row">
                <Button
                  icon={RotateCcw}
                  size="sm"
                  disabled={dirty}
                  busy={call.busy === 'reschedule'}
                  onClick={() => void call.run('reschedule', () => post(`/actions/${id}/reschedule-test`))}
                >
                  {draft.status === 'failed' ? 'Retry test' : 'Schedule test'}
                </Button>
              </div>
            )}
          </section>
        )}

        {/* ── Test email to the reviewer's own internal inbox ──────── */}
        {canOperate && testMode && draft.status !== 'cancelled' && (
          <section className="otr-ed__block">
            <p className="eyebrow row">
              Test email <InfoTip topic="testEmail" />
            </p>
            <p className="note">
              Emails this version to your own inbox exactly as the customer would receive it — same subject, content and sender. It changes nothing in the sequence and never goes to {view.campaign?.recipientEmail ?? 'the customer'}.
            </p>
            <div className="row">
              <Button
                icon={FlaskConical}
                size="sm"
                disabled={dirty}
                title={dirty ? 'Save your changes first' : undefined}
                busy={call.busy === 'preview'}
                onClick={() =>
                  void call.run('preview', async () => {
                    const r = (await post(`/actions/${id}/test-send`)) as { status?: string; to?: string[]; error?: string | null }
                    setPreview({ status: String(r?.status ?? ''), to: Array.isArray(r?.to) ? r.to : [], error: r?.error ?? null })
                  })
                }
              >
                Test email to my inbox
              </Button>
              {preview && (
                <span className={preview.status === 'accepted' ? 'cell-dim' : 'otr-err'} role="status">
                  {preview.status === 'accepted' ? `Delivered to ${preview.to.join(', ')}` : `Not sent — ${preview.error ?? preview.status}`}
                </span>
              )}
            </div>
          </section>
        )}

        {attempts.length > 0 && (
          <section className="otr-ed__block">
            <p className="eyebrow">Test deliveries</p>
            <table className="otr-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Result</th>
                  <th>Went to</th>
                  <th>Intended for</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((t) => (
                  <tr key={t.id}>
                    <td>{fmtDateTime(t.at)}</td>
                    <td>{t.kind === 'preview' ? 'Preview' : 'Scheduled'}</td>
                    <td>
                      <Chip tone={t.status === 'accepted' ? 'ok' : 'danger'}>{ATTEMPT_WORD[t.status] ?? t.status}</Chip>
                      {t.error && <span className="cell-dim"> {t.error}</span>}
                    </td>
                    <td className="mono">{t.actualRecipients.join(', ') || '—'}</td>
                    <td className="cell-dim">{t.intendedRecipient ?? '—'} (not emailed)</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        {!isTest && isApproved && (
          <section className="otr-ed__block otr-ed__send">
            <p className="eyebrow row">
              Send it <InfoTip topic="send" />
            </p>
            <ol className="otr-steps">
              <li>Click Open in Gmail — the address, subject and text are filled in for you.</li>
              <li>Read it once more and press send in Gmail.</li>
              <li>Come back and click Mark as sent — this starts the follow-up timer.</li>
            </ol>
            <div className="row">
              <a
                className="btn btn--primary btn--sm"
                href={buildGmailCompose(draft.recipient, draft.subject, draft.body)}
                target="_blank"
                rel="noreferrer noopener"
              >
                <Mail size={14} aria-hidden="true" /> Open in Gmail
              </a>
              <Button icon={Copy} size="sm" variant="ghost" onClick={() => void copy()}>
                {copied === true ? 'Copied' : 'Copy email'}
              </Button>
              <a className="btn btn--ghost btn--sm" href={buildMailto(draft.recipient, draft.subject, draft.body)}>
                <Mail size={14} aria-hidden="true" /> Other mail app
              </a>
            </div>
            {copied === false && (
              <p className="otr-err" role="alert">
                <AlertTriangle size={13} aria-hidden="true" /> This browser would not let the page copy for you. Select the
                text in the boxes above and copy it yourself, or use Open in Gmail.
              </p>
            )}
            {canOperate && (
              <>
                <label className="field-label" htmlFor={`sent-${id}`} style={{ marginTop: 'var(--s3)' }}>
                  Sent on (leave empty for now)
                </label>
                <input id={`sent-${id}`} className="otr-input" type="datetime-local" value={sentAt} onChange={(e) => setSentAt(e.target.value)} />
                <div className="row" style={{ marginTop: 'var(--s2)' }}>
                  <Button
                    icon={CheckCircle2}
                    variant="primary"
                    disabled={dirty}
                    busy={call.busy === 'sent'}
                    onClick={() =>
                      void call.run('sent', () => post(`/actions/${id}/mark-sent`, { sentAt: sentAt ? new Date(sentAt).toISOString() : null }))
                    }
                  >
                    Mark as sent
                  </Button>
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </Drawer>
  )
}
