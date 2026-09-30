import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, authApi, fetchAuthCapabilities, getToken, setToken, type AuthCapabilities, type SignedIn } from './api'
import type { Permission, Principal } from './types'

// WHO IS SIGNED IN, AND WHAT THEY MAY DO — TWO SEPARATE ANSWERS.
//
// Google proves who somebody is. What they may do is decided by the server on
// every request, from the configured admin list, and arrives as the
// permissions on the principal. Nothing here decides either one: the interface
// asks who it is talking to and renders what that answer allows.

interface AuthValue {
  principal: Principal | null
  loading: boolean
  error: string | null
  capabilities: AuthCapabilities | null
  /** A Google ID token from the browser, verified by the server. */
  signInWithGoogle: (credential: string) => Promise<void>
  /** An email address and password, against an account created here. */
  signIn: (email: string, password: string) => Promise<void>
  /** Takes the session a completed sign-up or reset just returned. */
  accept: (result: SignedIn) => Promise<void>
  signOut: () => void
  can: (permission: Permission) => boolean
  /** Admin-only features, asked as a question rather than inferred in ten places. */
  isAdmin: boolean
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null)

  useEffect(() => {
    void fetchAuthCapabilities().then(setCapabilities)
  }, [])

  const load = useCallback(async () => {
    if (!getToken()) {
      setPrincipal(null)
      setLoading(false)
      return
    }
    try {
      setPrincipal(await api.get<Principal>('/me'))
      setError(null)
    } catch (err) {
      // An expired or rejected session signs out rather than leaving the
      // interface in a half-authenticated state. The reason is kept so the
      // sign-in screen can say what happened.
      if (err instanceof ApiError && (err.isUnauthorized || err.isForbidden)) {
        setToken(null)
        setPrincipal(null)
        setError(err.isForbidden ? err.message : null)
      } else {
        setError(err instanceof Error ? err.message : 'Could not verify your session.')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Every sign-in path ends here: take the token, then ask who we are. */
  const accept = useCallback(
    async (result: SignedIn) => {
      setToken(result.token)
      setLoading(true)
      await load()
    },
    [load],
  )

  const signInWithGoogle = useCallback(
    async (credential: string) => {
      setError(null)
      await accept(await authApi.google(credential))
    },
    [accept],
  )

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null)
      await accept(await authApi.login(email.trim(), password))
    },
    [accept],
  )

  const signOut = useCallback(() => {
    setToken(null)
    setPrincipal(null)
    setError(null)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      principal,
      loading,
      error,
      capabilities,
      signInWithGoogle,
      signIn,
      accept,
      signOut,
      can: (permission) => Boolean(principal?.permissions.includes(permission)),
      isAdmin: Boolean(principal?.permissions.includes('admin')),
    }),
    [principal, loading, error, capabilities, signInWithGoogle, signIn, accept, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
