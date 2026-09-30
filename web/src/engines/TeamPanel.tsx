import { useState } from 'react'
import { X } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Panel, Button, Chip, Unset } from '../components/ui/primitives'
import { InfoTip } from '../components/ui/InfoTip'
import { ErrorState } from '../components/ui/states'

// WHO HAS SIGNED IN, AND WHAT THEY HOLD.
//
// Two different things decide access here, and the panel is arranged to make
// that obvious rather than to hide it:
//
//   ADMIN comes from the server's configured list of email addresses and from
//   nowhere else. It cannot be granted from this screen — there is deliberately
//   no button for it — because a list that anyone with admin could add to
//   would stop being the thing that decides who holds admin.
//
//   EVERYTHING ELSE is an ordinary role, and can be adjusted here.
//
// Anyone who signs in with a work Google account becomes an ordinary user
// automatically, so this is a record of who has been in rather than a queue of
// people waiting to be let in.

interface Account {
  id: string | null
  email: string
  name: string | null
  status: string
  pictureUrl: string | null
  linkedToCrm: boolean
  role: string | null
  isAdmin: boolean
  signInCount: number
  lastLoginAt: string | null
  createdAt: string
}

const ROLES = [
  { value: 'viewer', label: 'Viewer', what: 'Can look at everything. Cannot run anything.' },
  { value: 'operator', label: 'Operator', what: 'Can run the engines and prepare drafts. Cannot approve.' },
  { value: 'approver', label: 'Approver', what: 'Can approve and send what an operator prepared.' },
] as const

const HELP = {
  title: 'Team access',
  what: 'Everyone who has signed in with Google. Anyone with a work account becomes an ordinary user automatically; administrators are set on the server by email address.',
  next: 'Adjust an ordinary role here. To make someone an administrator, add their address to AUTH_ADMIN_EMAILS on the server.',
}

export function TeamPanel() {
  const { principal } = useAuth()
  const list = useAsync<{ accounts: Account[] }>((signal) => api.get('/admin/accounts', { signal }), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const accounts = list.data?.accounts ?? []
  const admins = accounts.filter((a) => a.isAdmin)
  const others = accounts.filter((a) => !a.isAdmin)

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      list.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work.')
    } finally {
      setBusy(null)
    }
  }

  const row = (a: Account, controls: boolean) => (
    <li key={a.email} className="team__row">
      <span className="team__who">
        {a.pictureUrl ? (
          <img className="team__avatar" src={a.pictureUrl} alt="" referrerPolicy="no-referrer" />
        ) : null}
        <span className="team__whotext">
          <span className="team__name">{a.name ?? a.email}</span>
          <span className="cell-dim">{a.email}</span>
          <span className="team__meta">
            {a.signInCount > 0
              ? `Signed in ${a.signInCount} time${a.signInCount === 1 ? '' : 's'}`
              : 'Has not signed in yet'}
            {a.lastLoginAt ? ` · last ${new Date(a.lastLoginAt).toLocaleDateString()}` : ''}
            {a.linkedToCrm ? ' · linked to NXT Sales' : ''}
          </span>
        </span>
      </span>
      <span className="team__actions">
        {a.isAdmin ? (
          <Chip tone="ok" title="Set on the server, by email address">
            Admin
          </Chip>
        ) : controls ? (
          <>
            <select
              className="otr-input team__role"
              value={a.role ?? 'operator'}
              disabled={busy === `role:${a.email}`}
              onChange={(e) => void act(`role:${a.email}`, () => api.post('/admin/members', { email: a.email, role: e.target.value }))}
              aria-label={`Role for ${a.email}`}
            >
              {ROLES.map((r) => (
                <option key={r.value} value={r.value} title={r.what}>
                  {r.label}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="quiet"
              icon={X}
              busy={busy === `remove:${a.email}`}
              title="They can sign in again, and come back as an ordinary user."
              onClick={() => void act(`remove:${a.email}`, () => api.del(`/admin/members/${encodeURIComponent(a.email)}`))}
            >
              Remove
            </Button>
          </>
        ) : null}
        {a.email === principal?.email && <Chip>You</Chip>}
      </span>
    </li>
  )

  return (
    <Panel
      title={
        <span className="row">
          Team access <InfoTip help={HELP} label="team access" />
        </span>
      }
      subtitle="Everyone who has signed in with Google, and what they hold"
    >
      {error && (
        <p className="otr-err" role="alert">
          {error}
        </p>
      )}

      {list.loading && !list.data ? (
        <Unset what="Loading…" />
      ) : list.error ? (
        <ErrorState error={list.error} what="The team list could not be read" onRetry={list.refresh} />
      ) : (
        <>
          <div className="team__block">
            <p className="eyebrow">Administrators ({admins.length})</p>
            <p className="note">
              Set on the server, by email address. They are the only people who can approve work, see what Gemini has
              cost, and manage access. To change this list, edit <code>AUTH_ADMIN_EMAILS</code> on the server — it takes
              effect the next time that person signs in.
            </p>
            {admins.length === 0 ? (
              <Unset what="No configured administrator has signed in yet" />
            ) : (
              <ul className="team__list">{admins.map((a) => row(a, false))}</ul>
            )}
          </div>

          <div className="team__block">
            <p className="eyebrow">Everyone else ({others.length})</p>
            <p className="note">
              Anyone signing in with a work Google account starts as an operator: they can run the engines and prepare
              drafts, but cannot approve or send.
            </p>
            {others.length === 0 ? (
              <Unset what="Nobody else has signed in yet" />
            ) : (
              <ul className="team__list">{others.map((a) => row(a, true))}</ul>
            )}
          </div>
        </>
      )}
    </Panel>
  )
}
