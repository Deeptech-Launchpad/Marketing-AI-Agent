import { useEffect, useState, type FormEvent } from 'react'
import { authApi } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { AgentMark } from '../agent/AgentMark'
import { Logo } from './Logo'
import { Button } from '../ui/primitives'
import { GoogleButton } from './GoogleButton'
import { PIPELINE, numberWord } from '../../lib/engines'
import './signin.css'

// SIGN IN, CREATE AN ACCOUNT, OR RECOVER ONE.
//
// Four things happen on this one screen, and which one is showing is the only
// state it keeps. They are deliberately not four routes: nobody is signed in
// yet, so there is no app to route inside of.
//
// Two ways in, side by side. An account on this platform — email and password,
// or Google — is the normal way. NXT Sales credentials still work, kept
// underneath for everyone who was using them before this existed.
//
// Signing in is not the same as being let in. A new account has no role until
// an admin grants one, and that state is shown as itself rather than as an
// error, because nothing has gone wrong: somebody just has to approve it.

type View = 'signIn' | 'create' | 'forgot' | 'reset' | 'nxtSales'

/** A reset link opens this screen with the token in the address. */
function tokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const url = new URL(window.location.href)
  const token = url.searchParams.get('token')
  return url.pathname.replace(/\/+$/, '').endsWith('/reset-password') && token ? token : null
}

export function SignIn() {
  const { signIn, signInWithGoogle, signInWithNxtSales, createAccount, capabilities, awaitingAccess, error: sessionError } = useAuth()

  const resetToken = tokenFromUrl()
  const [view, setView] = useState<View>(resetToken ? 'reset' : 'signIn')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [devLink, setDevLink] = useState<string | null>(null)

  // Moving between views clears whatever the last one was saying.
  useEffect(() => {
    setError(null)
    setNotice(null)
    setDevLink(null)
  }, [view])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (view === 'signIn') return void run(() => signIn(email, password))
    if (view === 'nxtSales') return void run(() => signInWithNxtSales(email, password))
    if (view === 'create') return void run(() => createAccount(email, password, name))
    if (view === 'forgot') {
      return void run(async () => {
        const r = await authApi.forgotPassword(email.trim())
        setNotice(r.message)
        setDevLink(r.devResetLink ?? null)
      })
    }
    if (view === 'reset' && resetToken) {
      return void run(async () => {
        await authApi.resetPassword(resetToken, password)
        setNotice('Your password has been changed. Sign in with it below.')
        setPassword('')
        window.history.replaceState({}, '', '/')
        setView('signIn')
      })
    }
  }

  // Someone signed in, but no admin has given them a role yet. Nothing has
  // failed; the account simply is not allowed in.
  if (awaitingAccess) {
    return (
      <Shell busy={false}>
        <div className="signin__pending" role="status">
          <h2 className="signin__pendingtitle">Your account is waiting for approval</h2>
          <p className="signin__pendingtext">
            {sessionError ?? 'An administrator has to grant you a role before you can use the platform.'}
          </p>
          <p className="signin__pendingtext">
            Ask an administrator to give you access. You will be able to sign in with the same details once they have.
          </p>
        </div>
        <button type="button" className="signin__link" onClick={() => window.location.reload()}>
          Check again
        </button>
      </Shell>
    )
  }

  const localOff = capabilities && !capabilities.localSignIn
  const showGoogle = Boolean(capabilities?.google && capabilities.googleClientId) && view !== 'nxtSales' && view !== 'reset'

  return (
    <Shell busy={busy}>
      <form onSubmit={submit} className="signin__form">
        {view === 'create' && (
          <>
            <label className="signin__label" htmlFor="name">
              Your name
            </label>
            <input
              id="name"
              className="signin__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              placeholder="Optional"
            />
          </>
        )}

        {view !== 'reset' && (
          <>
            <label className="signin__label" htmlFor="email">
              Work email
            </label>
            <input
              id="email"
              type="email"
              className="signin__input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </>
        )}

        {view !== 'forgot' && (
          <>
            <label className="signin__label" htmlFor="password">
              {view === 'create' ? 'Choose a password' : view === 'reset' ? 'New password' : 'Password'}
            </label>
            <input
              id="password"
              type="password"
              className="signin__input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={view === 'signIn' || view === 'nxtSales' ? 'current-password' : 'new-password'}
              required
              autoFocus={view === 'reset'}
            />
            {(view === 'create' || view === 'reset') && (
              <p className="signin__hint">At least 10 characters, including a letter and a number.</p>
            )}
          </>
        )}

        {view === 'create' && capabilities?.allowedDomains?.length ? (
          <p className="signin__hint">Accounts can be created for: {capabilities.allowedDomains.join(', ')}.</p>
        ) : null}

        {localOff && view !== 'nxtSales' && (
          <p className="signin__note" role="status">
            {capabilities?.localSignInReason} You can still sign in with your NXT Sales credentials below.
          </p>
        )}

        {notice && (
          <p className="signin__notice" role="status">
            {notice}
          </p>
        )}
        {devLink && (
          <p className="signin__notice">
            No mail server is configured, so the link is shown here for testing:{' '}
            <a href={devLink} className="signin__link">
              open the reset link
            </a>
          </p>
        )}
        {(error || (sessionError && view === 'signIn')) && (
          <p className="signin__error" role="alert">
            {error ?? sessionError}
          </p>
        )}

        <Button type="submit" variant="primary" busy={busy}>
          {view === 'create'
            ? 'Create account'
            : view === 'forgot'
              ? 'Email me a reset link'
              : view === 'reset'
                ? 'Set new password'
                : 'Sign in'}
        </Button>
      </form>

      {showGoogle && capabilities?.googleClientId && (
        <>
          <div className="signin__or">
            <span>or</span>
          </div>
          <GoogleButton
            clientId={capabilities.googleClientId}
            disabled={busy}
            onCredential={(credential) => void run(() => signInWithGoogle(credential))}
          />
        </>
      )}

      <div className="signin__links">
        {view === 'signIn' && (
          <>
            <button type="button" className="signin__link" onClick={() => setView('forgot')}>
              Forgot password?
            </button>
            <button type="button" className="signin__link" onClick={() => setView('create')}>
              Create an account
            </button>
          </>
        )}
        {(view === 'create' || view === 'forgot' || view === 'nxtSales') && (
          <button type="button" className="signin__link" onClick={() => setView('signIn')}>
            ← Back to sign in
          </button>
        )}
      </div>

      <p className="signin__foot">
        {view === 'nxtSales' ? (
          <>
            Your NXT Sales credentials sign you in here. Access to each engine follows the role you hold on this platform.{' '}
            <button type="button" className="signin__link" onClick={() => setView('signIn')}>
              Use a Marketing AI account instead
            </button>
          </>
        ) : (
          <>
            Access to each engine follows the role you hold on this platform.{' '}
            <button type="button" className="signin__link" onClick={() => setView('nxtSales')}>
              Sign in with NXT Sales instead
            </button>
          </>
        )}
      </p>
    </Shell>
  )
}

function Shell({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <div className="signin">
      <div className="signin__panel">
        <div className="signin__brand">
          <Logo height={26} />
        </div>

        <div className="signin__intro">
          <AgentMark state={busy ? 'running' : 'idle'} size={32} />
          <div>
            <h1 className="signin__title">Marketing AI</h1>
            <p className="signin__sub">One platform, {numberWord(PIPELINE.length)} specialised engines.</p>
          </div>
        </div>

        {children}
      </div>
    </div>
  )
}
