import { useState } from 'react'
import { Ban, Check, X } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Panel, Button, Chip, Unset } from '../components/ui/primitives'
import { InfoTip } from '../components/ui/InfoTip'
import { ErrorState } from '../components/ui/states'

// WHO HAS AN ACCOUNT HERE, AND WHAT THEY HOLD.
//
// This is the record of every registered user: the address, the name, whether
// that address was ever proved, how they get in (Google, a password, or both),
// whether the account is active, and when they were last here.
//
// Two different things decide access, and the panel is arranged to make that
// obvious rather than to hide it:
//
//   ADMIN comes from the server's configured list of email addresses and from
//   nowhere else. It cannot be granted from this screen — there is deliberately
//   no button for it — because a list that anyone with admin could add to
//   would stop being the thing that decides who holds admin.
//
//   EVERYTHING ELSE is an ordinary role, and can be adjusted here.
//
// Anyone who signs in with a work Google account, or creates an account with a
// verified email address, becomes an ordinary user automatically — so this is a
// record of who has been in rather than a queue of people waiting to be let in.
//
// Disabling is the one control here that stops somebody getting in at all. It
// is enforced by the server on every request, not just at sign-in, so an open
// session ends at its next call.

interface Account {
  id: string | null
  email: string
  name: string | null
  status: string
  emailVerified: boolean
  /** 'google', 'password', or both. Empty when no account exists yet. */
  signInMethods: string[]
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
  title: 'Registered users',
  what: 'Every account on this platform, with the address, how they sign in, whether the account is active, and when they were last here. Anyone with an allowed work address becomes an ordinary user automatically; administrators are set on the server by email address.',
  next: 'Adjust an ordinary role or disable an account here. To make someone an administrator, add their address to AUTH_ADMIN_EMAILS on the server.',
}

/** How this person gets in, in words rather than field names. */
function methodsText(a: Account): string {
  if (a.signInMethods.length === 2) return 'Google and password'
  if (a.signInMethods.includes('google')) return 'Google'
  if (a.signInMethods.includes('password')) return 'Password'
  return 'No account yet'
}

function lastSeen(a: Account): string {
  if (!a.lastLoginAt) return 'Has not signed in yet'
  const when = new Date(a.lastLoginAt)
  const times = `${a.signInCount} time${a.signInCount === 1 ? '' : 's'}`
  return `Last in ${when.toLocaleString()} · ${times}`
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
            {methodsText(a)} · {lastSeen(a)}
            {a.linkedToCrm ? ' · linked to NXT Sales' : ''}
          </span>
        </span>
      </span>
      <span className="team__actions">
        {a.status === 'disabled' && (
          <Chip tone="danger" title="Refused at sign-in and on every request.">
            Disabled
          </Chip>
        )}
        {a.status === 'no_account' && (
          <Chip tone="warn" title="A role was granted to this address, but nobody has signed in with it.">
            Invited
          </Chip>
        )}
        {a.signInMethods.includes('password') && !a.emailVerified && (
          <Chip tone="warn" title="This address has not been proved with a code.">
            Unverified
          </Chip>
        )}
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
        {a.id && a.email !== principal?.email && (
          <Button
            size="sm"
            variant="quiet"
            icon={a.status === 'disabled' ? Check : Ban}
            busy={busy === `status:${a.email}`}
            title={
              a.status === 'disabled'
                ? 'Let them sign in again. Their role is unchanged.'
                : 'Stop them signing in, and end any open session at its next request.'
            }
            onClick={() =>
              void act(`status:${a.email}`, () =>
                api.patch(`/admin/accounts/${encodeURIComponent(a.id!)}/status`, {
                  status: a.status === 'disabled' ? 'active' : 'disabled',
                }),
              )
            }
          >
            {a.status === 'disabled' ? 'Enable' : 'Disable'}
          </Button>
        )}
        {a.email === principal?.email && <Chip>You</Chip>}
      </span>
    </li>
  )

  return (
    <Panel
      title={
        <span className="row">
          Registered users <InfoTip help={HELP} label="registered users" />
        </span>
      }
      subtitle="Every account on this platform, how they sign in, and what they hold"
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
              Anyone who signs in with a work Google account, or creates an account with a verified work address, starts
              as an operator: they can run the engines and prepare drafts, but cannot approve or send.
            </p>
            {others.length === 0 ? (
              <Unset what="Nobody else has an account yet" />
            ) : (
              <ul className="team__list">{others.map((a) => row(a, true))}</ul>
            )}
          </div>
        </>
      )}
    </Panel>
  )
}
