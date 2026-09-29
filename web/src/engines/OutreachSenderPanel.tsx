import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Panel, Button, Chip, Field, Unset } from '../components/ui/primitives'
import './outreach/outreach.css'

// THE OUTREACH SENDER — the shared part of how outreach emails are signed.
//
// Each email is signed by the PERSON who starts the outreach — the logged-in
// user, by their NXT Sales login name — and they send it from their own mail
// program. Only the company name (and an optional signature) is shared, set
// once here by an administrator. No person's name or email is stored here.

interface Shared {
  companyName: string
  signature: string
}

function readShared(body: unknown): { sender: Shared; configured: boolean } | null {
  const b = body as { sender?: Partial<Shared>; configured?: unknown } | null
  if (!b || typeof b !== 'object' || !b.sender || typeof b.sender !== 'object') return null
  const s = b.sender
  return {
    sender: {
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
  const current = readShared(loaded.data)
  const [form, setForm] = useState<Shared>({ companyName: '', signature: '' })
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
      await api.post('/outreach/sequence/sender', { companyName: form.companyName.trim(), signature: form.signature })
      setSaved(true)
      loaded.refresh()
    } catch (err) {
      setError((err as Error)?.message || 'The company name could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Outreach sender"
      subtitle="Emails are signed by the person who starts the outreach — their own NXT Sales login name — and sent from their own mail program"
      actions={current ? <Chip tone={current.configured ? 'ok' : 'warn'}>{current.configured ? 'Configured' : 'Not set'}</Chip> : null}
    >
      {loaded.loading && !loaded.data ? (
        <Unset what="Loading…" />
      ) : loaded.error ? (
        <p className="note">The sender settings could not be read: {loaded.error.message}</p>
      ) : !current ? (
        <p className="note">The sender settings could not be read from the server&rsquo;s response.</p>
      ) : isAdmin ? (
        <>
          <label className="field-label" htmlFor="sender-company">
            Company name (used in every email)
          </label>
          <input id="sender-company" className="otr-input" value={form.companyName} onChange={(e) => setForm((f) => ({ ...f, companyName: e.target.value }))} />
          <label className="field-label" htmlFor="sender-signature" style={{ marginTop: 'var(--s3)' }}>
            Signature (added under the sender&rsquo;s name; optional — do not put one person&rsquo;s details here)
          </label>
          <textarea id="sender-signature" className="textarea" rows={3} value={form.signature} onChange={(e) => setForm((f) => ({ ...f, signature: e.target.value }))} />
          {error && (
            <p className="otr-err" role="alert" style={{ marginTop: 'var(--s2)' }}>
              {error}
            </p>
          )}
          <div className="row" style={{ marginTop: 'var(--s3)' }}>
            <Button icon={Save} variant="primary" busy={busy} onClick={() => void save()}>
              Save sender
            </Button>
            {saved && <span className="cell-dim">Saved. New drafts use it; existing drafts keep theirs until regenerated.</span>}
          </div>
        </>
      ) : (
        <>
          <Field label="Company" value={current.sender.companyName || <Unset what="Not set" />} />
          <p className="note" style={{ marginTop: 'var(--s3)' }}>
            Only an administrator can change the sender.
          </p>
        </>
      )}
    </Panel>
  )
}
