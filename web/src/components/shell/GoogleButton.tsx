import { useEffect, useRef, useState } from 'react'

// THE GOOGLE SIGN-IN BUTTON.
//
// Google renders it themselves, into the element below, and hands back an ID
// TOKEN when someone uses it. That token means nothing until the server has
// verified it with Google's public keys — see src/auth/google.ts. Nothing here
// decides who anybody is; it only carries the token across.
//
// The script is loaded once, and only when a client id is actually configured,
// so a server without Google set up makes no request to Google at all.

interface GoogleAccounts {
  accounts: {
    id: {
      initialize: (o: { client_id: string; callback: (r: { credential?: string }) => void }) => void
      renderButton: (el: HTMLElement, o: Record<string, unknown>) => void
    }
  }
}
declare global {
  interface Window {
    google?: GoogleAccounts
  }
}

const SRC = 'https://accounts.google.com/gsi/client'

function loadScript(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve()
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`)
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve())
      existing.addEventListener('error', () => reject(new Error('load failed')))
    })
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = SRC
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('load failed'))
    document.head.appendChild(script)
  })
}

export function GoogleButton({
  clientId,
  onCredential,
  disabled,
}: {
  clientId: string
  onCredential: (credential: string) => void
  disabled?: boolean
}) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  // Kept in a ref so re-rendering the parent never re-initialises Google.
  const handler = useRef(onCredential)
  handler.current = onCredential

  useEffect(() => {
    let cancelled = false
    loadScript()
      .then(() => {
        if (cancelled || !host.current || !window.google?.accounts?.id) return
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (response) => {
            if (response?.credential) handler.current(response.credential)
          },
        })
        window.google.accounts.id.renderButton(host.current, {
          theme: 'outline',
          size: 'large',
          width: 320,
          text: 'signin_with',
          shape: 'rectangular',
        })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [clientId])

  if (failed) {
    return (
      <p className="signin__note" role="status">
        Google sign-in could not be loaded. Check your connection, or sign in with your email and password.
      </p>
    )
  }
  return <div ref={host} className={`signin__google${disabled ? ' is-disabled' : ''}`} aria-busy={disabled} />
}
