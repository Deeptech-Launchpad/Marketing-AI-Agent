import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Panel, Button, Chip, Field, Unset } from '../components/ui/primitives'
import './outreach/outreach.css'

// THE OUTREACH SENDER — who every Sales-approved email is signed as.
//
// Set once by an administrator, read by the sequence when it fills
// [Sender first name] and [Sender company]. Nothing about the sender is
// written into a prompt or into the code: until this is set, drafts can be
// prepared but none can be approved.

interface Sender {
  firstName: string
  fullName: string
  email: string
  companyName: string
  signature: string
}

const EMPTY: Sender = { firstName: '', fullName: '', email: '', companyName: '', signature: '' }

function readSender(body: unknown): { sender: Sender; configured: boolean } | null {
  const b = body as { sender?: Partial<Sender>; configured?: unknown } | null
  if (!b || typeof b !== 'object' || !b.sender || typeof b.sender !== 'object') return null
  const s = b.sender
  return {
    sender: {
      firstName: typeof s.firstName === 'string' ? s.firstName : '',
      fullName: typeof s.fullName === 'string' ? s.fullName : '',
      email: typeof s.email === 'string' ? s.email : '',
      companyName: typeof s.companyName === 'string' ? s.companyName : '',
      signature: typeof s.signature === 'string' ? s.signature : '',
    },
    configured: b.configured === true,
  }
}

export function OutreachSenderPanel() {
  const { can } = useAuth()
  const isAdmin = can('admin')
  const loaded = useAsync<unknown>((signal) => api.get('/outreach/sequence/sender', { signal }), [])
  const current = readSender(loaded.data)
  const [form, setForm] = useState<Sender>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (current) setForm(current.sender)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.data])

  const save = async () => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      await api.post('/outreach/sequence/sender', {
        firstName: form.firstName.trim(),
        fullName: form.fullName.trim(),
        email: form.email.trim(),
        companyName: form.companyName.trim(),
        signature: form.signature,
      })
      setSaved(true)
      loaded.refresh()
    } catch (err) {
      setError((err as Error)?.message || 'The sender could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const set = (k: keyof Sender) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Panel
      title="Outreach sender"
      subtitle="Who every Sales-approved outreach email is signed as"
      actions={current ? <Chip tone={current.configured ? 'ok' : 'warn'}>{current.configured ? 'Configured' : 'Not set'}</Chip> : null}
    >
      {loaded.loading && !loaded.data ? (
        <Unset what="Loading…" />
      ) : loaded.error ? (
        <p className="note">The sender could not be read: {loaded.error.message}</p>
      ) : !current ? (
        <p className="note">The sender could not be read from the server&rsquo;s response.</p>
      ) : isAdmin ? (
        <>
          <div className="otr-grid">
            <label>
              <span className="field-label">First name (signs the email)</span>
              <input className="otr-input" value={form.firstName} onChange={set('firstName')} />
            </label>
            <label>
              <span className="field-label">Full name</span>
              <input className="otr-input" value={form.fullName} onChange={set('fullName')} />
            </label>
            <label>
              <span className="field-label">Email</span>
              <input className="otr-input" type="email" value={form.email} onChange={set('email')} />
            </label>
            <label>
              <span className="field-label">Company</span>
              <input className="otr-input" value={form.companyName} onChange={set('companyName')} />
            </label>
          </div>
          <label className="field-label" htmlFor="sender-signature" style={{ marginTop: 'var(--s3)' }}>
            Signature (added under the sign-off name; optional)
          </label>
          <textarea id="sender-signature" className="textarea" rows={3} value={form.signature} onChange={set('signature')} />
          {error && (
            <p className="otr-err" role="alert" style={{ marginTop: 'var(--s2)' }}>
              {error}
            </p>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button icon={Save} variant="primary" busy={busy} onClick={() => void save()}>
              Save sender
            </Button>
            {saved && <span className="cell-dim">Saved. New drafts use this sender; existing drafts keep theirs until regenerated.</span>}
          </div>
        </>
      ) : (
        <>
          <Field label="First name" value={current.sender.firstName || <Unset what="Not set" />} />
          <Field label="Full name" value={current.sender.fullName || <Unset what="Not set" />} />
          <Field label="Email" value={current.sender.email || <Unset what="Not set" />} />
          <Field label="Company" value={current.sender.companyName || <Unset what="Not set" />} />
          <p className="note" style={{ marginTop: 'var(--s3)' }}>
            Only an administrator can change the sender.
          </p>
        </>
      )}
    </Panel>
  )
}
