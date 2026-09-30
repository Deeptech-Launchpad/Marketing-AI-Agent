import { useState } from 'react'
import { UserPlus, X } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Panel, Button, Chip, Unset } from '../components/ui/primitives'
import { InfoTip } from '../components/ui/InfoTip'
import { ErrorState } from '../components/ui/states'

// WHO MAY USE THIS PLATFORM — AND WHO IS STILL WAITING.
//
// Signing in and being allowed in are two different things, and this is where
// the second one is decided. Somebody who creates an account can do nothing at
// all until an admin gives them a role here; until then they appear as
// "waiting for approval", which is the only way an admin would know to act.
//
// The four roles, and why they are separate: an operator runs the engines, an
// approver signs work off, and they are deliberately not the same person —
// whoever prepares a campaign should not be the one who approves it.

interface Account {
  id: string | null
  email: string
  name: string | null
  status: string
  emailVerified: boolean
  signInMethods: string[]
  linkedToCrm: boolean
  role: string | null
  lastLoginAt: string | null
  createdAt: string
}

const ROLES = [
  { value: 'viewer', label: 'Viewer', what: 'Can look at everything. Cannot run, approve or send anything.' },
  { value: 'operator', label: 'Operator', what: 'Can run the engines and prepare drafts. Cannot approve or send.' },
  { value: 'approver', label: 'Approver', what: 'Can approve and send what an operator prepared.' },
  { value: 'admin', label: 'Admin', what: 'Everything, including granting access to other people.' },
] as const

const METHOD_LABEL: Record<string, string> = {
  password: 'Email & password',
  google: 'Google',
  nxt_sales: 'NXT Sales',
}

const HELP = {
  title: 'Team access',
  what: 'Everyone who can sign in. Creating an account grants nothing on its own — a person sees no data at all until you give them a role here.',
  next: 'Give a role to anyone marked "Waiting for approval", or remove access you no longer want.',
}

export function TeamPanel() {
  const { principal } = useAuth()
  const list = useAsync<{ accounts: Account[] }>((signal) => api.get('/admin/accounts', { signal }), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<string>('viewer')

  const accounts = list.data?.accounts ?? []
  const waiting = accounts.filter((a) => !a.role)
  const allowed = accounts.filter((a) => a.role)

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

  const setRole = (email: string, role: string) =>
    act(`role:${email}`, () => api.post('/admin/members', { email, role }))

  const removeAccess = (email: string) =>
    act(`remove:${email}`, () => api.del(`/admin/members/${encodeURIComponent(email)}`))

  return (
    <Panel
      title={
        <span className="row">
          Team access <InfoTip help={HELP} label="team access" />
        </span>
      }
      subtitle="Who can sign in, and what each person is allowed to do"
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
          {waiting.length > 0 && (
            <div className="team__block">
              <p className="eyebrow">Waiting for approval ({waiting.length})</p>
              <p className="note">
                These people have created an account but can see nothing yet. Give each one a role, or leave them
                without one.
              </p>
              <ul className="team__list">
                {waiting.map((a) => (
                  <li key={a.email} className="team__row">
                    <span className="team__who">
                      <span className="team__name">{a.name ?? a.email}</span>
                      <span className="cell-dim">{a.email}</span>
                      <span className="team__meta">
                        {a.signInMethods.map((m) => METHOD_LABEL[m] ?? m).join(', ') || 'No sign-in method'}
                        {a.emailVerified ? ' · email verified' : ''}
                        {a.linkedToCrm ? ' · linked to NXT Sales' : ''}
                      </span>
                    </span>
                    <span className="team__actions">
                      {ROLES.map((r) => (
                        <Button
                          key={r.value}
                          size="sm"
                          variant={r.value === 'viewer' ? 'primary' : 'ghost'}
                          busy={busy === `role:${a.email}`}
                          title={r.what}
                          onClick={() => void setRole(a.email, r.value)}
                        >
                          {r.label}
                        </Button>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="team__block">
            <p className="eyebrow">Has access ({allowed.length})</p>
            {allowed.length === 0 ? (
              <Unset what="Nobody has been granted a role yet" />
            ) : (
              <ul className="team__list">
                {allowed.map((a) => (
                  <li key={a.email} className="team__row">
                    <span className="team__who">
                      <span className="team__name">{a.name ?? a.email}</span>
                      <span className="cell-dim">{a.email}</span>
                      <span className="team__meta">
                        {a.signInMethods.map((m) => METHOD_LABEL[m] ?? m).join(', ') || 'Has not signed in yet'}
                        {a.lastLoginAt ? ` · last signed in ${new Date(a.lastLoginAt).toLocaleDateString()}` : ''}
                      </span>
                    </span>
                    <span className="team__actions">
                      <select
                        className="otr-input team__role"
                        value={a.role ?? 'viewer'}
                        disabled={busy === `role:${a.email}` || a.email === principal?.email}
                        onChange={(e) => void setRole(a.email, e.target.value)}
                        aria-label={`Role for ${a.email}`}
                      >
                        {ROLES.map((r) => (
                          <option key={r.value} value={r.value}>
                            {r.label}
                          </option>
                        ))}
                      </select>
                      {a.email === principal?.email ? (
                        <Chip>You</Chip>
                      ) : (
                        <Button
                          size="sm"
                          variant="quiet"
                          icon={X}
                          busy={busy === `remove:${a.email}`}
                          onClick={() => void removeAccess(a.email)}
                        >
                          Remove
                        </Button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="team__block">
            <p className="eyebrow">Give access to someone who has not signed in yet</p>
            <p className="note">
              Their role is waiting for them: the next time they sign in with that email — by any method — they come
              straight in with it.
            </p>
            <div className="row">
              <input
                className="otr-input team__email"
                type="email"
                placeholder="name@altiusnxt.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                aria-label="Email address"
              />
              <select
                className="otr-input team__role"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value)}
                aria-label="Role"
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                icon={UserPlus}
                busy={busy === `role:${inviteEmail.trim().toLowerCase()}`}
                disabled={!inviteEmail.trim()}
                onClick={() =>
                  void setRole(inviteEmail.trim().toLowerCase(), inviteRole).then(() => setInviteEmail(''))
                }
              >
                Give access
              </Button>
            </div>
          </div>
        </>
      )}
    </Panel>
  )
}
