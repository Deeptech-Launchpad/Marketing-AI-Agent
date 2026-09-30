import { useState } from 'react'
import { useAuth } from '../../lib/auth'
import { AgentMark } from '../agent/AgentMark'
import { Logo } from './Logo'
import { GoogleButton } from './GoogleButton'
import { PIPELINE, numberWord } from '../../lib/engines'
import './signin.css'

// SIGN IN WITH GOOGLE — THE ONLY WAY IN.
//
// There is no password field here because there is no password anywhere: the
// platform stores none, so none can be guessed, leaked or reset. Google proves
// who somebody is, and the server decides whether that person may sign in at
// all and what they may do.
//
// Everything this screen can show is a real state with a real cause: Google
// not configured, an account outside the allowed domains, a disabled account.
// Each is reported in the server's own words rather than as "sign in failed".

export function SignIn() {
  const { signInWithGoogle, capabilities, error: sessionError } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const attempt = async (credential: string) => {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle(credential)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That sign-in was not accepted.')
    } finally {
      setBusy(false)
    }
  }

  const notReady = capabilities && !capabilities.ready
  const domains = capabilities?.allowedDomains ?? []

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

        {notReady ? (
          <p className="signin__error" role="alert">
            {capabilities?.reason} Ask whoever runs this server to configure it.
          </p>
        ) : (
          <div className="signin__googlewrap">
            {capabilities?.googleClientId ? (
              <GoogleButton clientId={capabilities.googleClientId} disabled={busy} onCredential={(c) => void attempt(c)} />
            ) : (
              <p className="signin__note" role="status">
                Checking how this server is configured…
              </p>
            )}
          </div>
        )}

        {(error || sessionError) && (
          <p className="signin__error" role="alert">
            {error ?? sessionError}
          </p>
        )}

        <p className="signin__foot">
          {domains.length > 0 ? (
            <>
              Sign in with your {domains.join(' or ')} Google account. What you can do here follows the role you hold on
              this platform.
            </>
          ) : (
            <>Sign in with your work Google account. What you can do here follows the role you hold on this platform.</>
          )}
        </p>
      </div>
    </div>
  )
}
