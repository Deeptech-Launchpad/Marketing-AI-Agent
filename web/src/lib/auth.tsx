import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  api,
  ApiError,
  authApi,
  fetchAuthCapabilities,
  getToken,
  loginWithNxtSales,
  setToken,
  type AuthCapabilities,
} from './api'
import type { Permission, Principal } from './types'

// WHO IS SIGNED IN, AND WHAT THEY MAY DO — TWO SEPARATE ANSWERS.
//
// Identity comes from one of two places: an account created on this platform
// (email and password, or Google), or NXT Sales. Either way the answer to
// "what may they do" comes from the marketing agent alone, as it always has.
//
// Neither is decided here: the interface asks who it is talking to and renders
// what that answer allows. A signed-in account with no role granted yet is a
// real state, and it is shown as itself rather than as a failure.

interface AuthValue {
  principal: Principal | null
  loading: boolean
  error: string | null
  /** True when signed in but no admin has granted a role yet. */
  awaitingAccess: boolean
  capabilities: AuthCapabilities | null
  /** Email and password, against this platform's own accounts. */
  signIn: (email: string, password: string) => Promise<void>
  /** A Google ID token from the browser, verified by the server. */
  signInWithGoogle: (credential: string) => Promise<void>
  /** The original path: NXT Sales' own credentials. */
  signInWithNxtSales: (email: string, password: string) => Promise<void>
  createAccount: (email: string, password: string, name?: string) => Promise<void>
  signOut: () => void
  can: (permission: Permission) => boolean
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [awaitingAccess, setAwaitingAccess] = useState(false)
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
      setAwaitingAccess(false)
    } catch (err) {
      // An expired or rejected token signs the session out rather than leaving
      // the interface in a half-authenticated state. A FORBIDDEN answer is
      // different: the token is good and the person simply has no role yet, so
      // the reason is kept and shown rather than silently discarded.
      if (err instanceof ApiError && (err.isUnauthorized || err.isForbidden)) {
        setToken(null)
        setPrincipal(null)
        setError(err.isForbidden ? err.message : null)
        setAwaitingAccess(err.isForbidden)
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

  /** Shared by every sign-in path: take the token, then ask who we are. */
  const accept = useCallback(
    async (result: { token: string; hasAccess?: boolean }) => {
      setToken(result.token)
      setLoading(true)
      setAwaitingAccess(result.hasAccess === false)
      await load()
    },
    [load],
  )

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null)
      await accept(await authApi.login(email.trim(), password))
    },
    [accept],
  )

  const signInWithGoogle = useCallback(
    async (credential: string) => {
      setError(null)
      await accept(await authApi.google(credential))
    },
    [accept],
  )

  const createAccount = useCallback(
    async (email: string, password: string, name?: string) => {
      setError(null)
      await accept(await authApi.register(email.trim(), password, name))
    },
    [accept],
  )

  const signInWithNxtSales = useCallback(
    async (email: string, password: string) => {
      setError(null)
      await accept({ token: await loginWithNxtSales(email.trim(), password) })
    },
    [accept],
  )

  const signOut = useCallback(() => {
    setToken(null)
    setPrincipal(null)
    setError(null)
    setAwaitingAccess(false)
  }, [])

  const value = useMemo<AuthValue>(
    () => ({
      principal,
      loading,
      error,
      awaitingAccess,
      capabilities,
      signIn,
      signInWithGoogle,
      signInWithNxtSales,
      createAccount,
      signOut,
      can: (permission) => Boolean(principal?.permissions.includes(permission)),
    }),
    [principal, loading, error, awaitingAccess, capabilities, signIn, signInWithGoogle, signInWithNxtSales, createAccount, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
