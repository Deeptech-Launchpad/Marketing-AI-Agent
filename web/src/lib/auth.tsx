import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError, getToken, loginWithNxtSales, setToken } from './api'
import type { Permission, Principal } from './types'

// Identity comes from NXT Sales and permissions come from the marketing agent.
// Neither is decided here: the interface asks who it is talking to and renders
// what that answer allows.

interface AuthValue {
  principal: Principal | null
  loading: boolean
  error: string | null
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => void
  /** True when the signed-in member holds this permission. */
  can: (permission: Permission) => boolean
}

const AuthContext = createContext<AuthValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [principal, setPrincipal] = useState<Principal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
      // An expired or rejected token signs the session out rather than leaving
      // the interface in a half-authenticated state.
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

  const signIn = useCallback(
    async (email: string, password: string) => {
      setError(null)
      const token = await loginWithNxtSales(email, password)
      setToken(token)
      setLoading(true)
      await load()
    },
    [load],
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
      signIn,
      signOut,
      can: (permission) => Boolean(principal?.permissions.includes(permission)),
    }),
    [principal, loading, error, signIn, signOut],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
