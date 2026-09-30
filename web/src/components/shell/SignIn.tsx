import { useState } from 'react'
import { ApiError, authApi, type CodeSent } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { AgentMark } from '../agent/AgentMark'
import { Logo } from './Logo'
import { PIPELINE, numberWord } from '../../lib/engines'
import './signin.css'

// THE FRONT DOOR — AN ACCOUNT ON THIS PLATFORM, AND NOTHING ELSE.
//
// Sign in with an email address and a password, or create an account. Creating
// one and recovering one work the same way: the address is proved with a code
// sent to it before any password is accepted, so an account can only ever be
// made or taken back by somebody who reads that inbox.
//
// Signing in with Google was removed on 2026-09-30. It cannot be configured
// without a registered domain over HTTPS — Google refuses a bare IP address as
// an origin — and a button that cannot work is worse than no button. When there
// is a domain it comes back alongside what is here, not instead of it.
//
// This screen holds no rules of its own. It does not decide who may sign in,
// which addresses are allowed, or whether a code is still valid — the server
// decides all of that and answers in its own words, which is what gets shown.
// The one thing checked here is that the two password boxes match, because that
// is a typing mistake rather than a refusal.

type View = 'signin' | 'register' | 'forgot'
/** Both code flows are two steps: prove the address, then set the password. */
type Step = 'email' | 'code'

const PASSWORD_RULE = 'At least 10 characters, including a letter and a number.'

export function SignIn() {
  const { signIn, accept, capabilities, error: sessionError } = useAuth()

  const [view, setView] = useState<View>('signin')
  const [step, setStep] = useState<Step>('email')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<CodeSent | null>(null)

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')

  const go = (next: View) => {
    setView(next)
    setStep('email')
    setError(null)
    setSent(null)
    setPassword('')
    setConfirm('')
    setCode('')
  }

  /**
   * Runs one attempt and reports whatever came back.
   *
   * Every failure shown on this screen is the server's own sentence. Nothing
   * here turns a refusal into "sign in failed", because the difference between
   * "that code has expired" and "that address is not allowed here" is the
   * difference between trying again and asking an administrator.
   */
  const run = async (work: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const passwordsDiffer = password.length > 0 && confirm.length > 0 && password !== confirm

  const askForCode = (purpose: View) =>
    run(async () => {
      const result = purpose === 'register' ? await authApi.registerStart(email) : await authApi.forgotStart(email)
      setSent(result)
      setStep('code')
    })

  const useTheCode = (purpose: View) =>
    run(async () => {
      if (password !== confirm) throw new Error('Those two passwords are not the same. Type the same one twice.')
      const result =
        purpose === 'register'
          ? await authApi.registerVerify(email, code, password, name)
          : await authApi.forgotVerify(email, code, password)
      await accept(result)
    })

  const notReady = capabilities && !capabilities.ready
  const domains = capabilities?.allowedDomains ?? []
  const minutes = sent?.expiresInMinutes ?? capabilities?.otpMinutes ?? 10

  return (
    <div className="signin">
      <div className="signin__panel">
        <div className="signin__brand">
          <Logo height={26} />
        </div>

        <div className="signin__intro">
          <AgentMark state={busy ? 'running' : 'idle'} size={32} />
          <div>
            <h1 className="signin__title">
              {view === 'signin' ? 'Marketing AI' : view === 'register' ? 'Create your account' : 'Recover your account'}
            </h1>
            <p className="signin__sub">
              {view === 'signin'
                ? `One platform, ${numberWord(PIPELINE.length)} specialised engines.`
                : step === 'email'
                  ? 'We send a code to your work email address.'
                  : `Enter the code we sent to ${email}.`}
            </p>
          </div>
        </div>

        {notReady ? (
          <p className="signin__error" role="alert">
            {capabilities?.reason} Ask whoever runs this server to configure it.
          </p>
        ) : view === 'signin' ? (
          <>
            <form
              className="signin__form"
              onSubmit={(e) => {
                e.preventDefault()
                void run(() => signIn(email, password))
              }}
            >
              <label className="signin__label" htmlFor="si-email">
                Email
              </label>
              <input
                id="si-email"
                className="signin__input"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />

              <label className="signin__label" htmlFor="si-password">
                Password
              </label>
              <input
                id="si-password"
                className="signin__input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />

              <button className="btn btn--primary" type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
            </form>

            <div className="signin__links">
              <button className="signin__link" type="button" onClick={() => go('register')}>
                Create account
              </button>
              <button className="signin__link" type="button" onClick={() => go('forgot')}>
                Forgot password?
              </button>
            </div>
          </>
        ) : step === 'email' ? (
          <form
            className="signin__form"
            onSubmit={(e) => {
              e.preventDefault()
              void askForCode(view)
            }}
          >
            <label className="signin__label" htmlFor="si-email2">
              Work email
            </label>
            <input
              id="si-email2"
              className="signin__input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <p className="signin__hint">
              {domains.length > 0
                ? `Accounts here are for ${domains.join(' or ')} addresses.`
                : 'Use your work email address.'}
            </p>

            <button className="btn btn--primary" type="submit" disabled={busy}>
              {busy ? 'Sending…' : 'Send me a code'}
            </button>
          </form>
        ) : (
          <form
            className="signin__form"
            onSubmit={(e) => {
              e.preventDefault()
              void useTheCode(view)
            }}
          >
            {sent && (
              <p className="signin__notice" role="status">
                {sent.message}
                {sent.devCode && (
                  <>
                    {' '}
                    This server has no mail configured, so the code is shown here for local testing only:{' '}
                    <strong>{sent.devCode}</strong>
                  </>
                )}
              </p>
            )}

            <label className="signin__label" htmlFor="si-code">
              Verification code
            </label>
            <input
              id="si-code"
              className="signin__input signin__code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              required
            />
            <p className="signin__hint">It works once and expires {minutes} minutes after it was sent.</p>

            {view === 'register' && (
              <>
                <label className="signin__label" htmlFor="si-name">
                  Your name <span className="signin__optional">(optional)</span>
                </label>
                <input
                  id="si-name"
                  className="signin__input"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </>
            )}

            <label className="signin__label" htmlFor="si-new">
              {view === 'register' ? 'Choose a password' : 'New password'}
            </label>
            <input
              id="si-new"
              className="signin__input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />

            <label className="signin__label" htmlFor="si-confirm">
              Type it again
            </label>
            <input
              id="si-confirm"
              className="signin__input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            <p className="signin__hint">{passwordsDiffer ? 'Those two do not match yet.' : PASSWORD_RULE}</p>

            <button className="btn btn--primary" type="submit" disabled={busy || passwordsDiffer}>
              {busy ? 'Checking…' : view === 'register' ? 'Create account' : 'Set new password'}
            </button>

            <div className="signin__links">
              <button className="signin__link" type="button" disabled={busy} onClick={() => void askForCode(view)}>
                Send another code
              </button>
              <button className="signin__link" type="button" onClick={() => setStep('email')}>
                Use a different address
              </button>
            </div>
          </form>
        )}

        {(error || sessionError) && (
          <p className="signin__error" role="alert">
            {error ?? sessionError}
          </p>
        )}

        {view === 'signin' ? (
          <p className="signin__foot">
            {domains.length > 0 ? (
              <>Accounts here are for {domains.join(' or ')} addresses. </>
            ) : (
              <>Use your work email address. </>
            )}
            What you can do here follows the role you hold on this platform.
          </p>
        ) : (
          <p className="signin__foot">
            <button className="signin__link" type="button" onClick={() => go('signin')}>
              Back to sign in
            </button>
          </p>
        )}
      </div>
    </div>
  )
}
