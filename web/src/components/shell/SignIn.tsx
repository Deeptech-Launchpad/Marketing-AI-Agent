import { useState, type FormEvent } from 'react'
import { useAuth } from '../../lib/auth'
import { AgentMark } from '../agent/AgentMark'
import { Logo } from './Logo'
import { Button } from '../ui/primitives'
import './signin.css'

// Sign in.
//
// NXT Sales is the identity provider: the same credentials, the same token,
// no second directory. If the marketing agent then declines the token, the
// reason is shown as the backend gave it — usually that the account has not
// been granted a role on this platform.

export function SignIn() {
  const { signIn, error: sessionError } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.')
    } finally {
      setBusy(false)
    }
  }

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
            <p className="signin__sub">One platform, twelve specialised engines.</p>
          </div>
        </div>

        <form onSubmit={submit} className="signin__form">
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

          <label className="signin__label" htmlFor="password">
            Password
          </label>
          <input
            id="password"
            type="password"
            className="signin__input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          {(error || sessionError) && (
            <p className="signin__error" role="alert">
              {error ?? sessionError}
            </p>
          )}

          <Button type="submit" variant="primary" busy={busy}>
            Sign in
          </Button>
        </form>

        <p className="signin__foot">
          Your NXT Sales credentials sign you in here. Access to each engine follows the role you hold on this platform.
        </p>
      </div>
    </div>
  )
}
