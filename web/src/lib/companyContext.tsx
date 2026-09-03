import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import type { EnrichmentList } from './types'

// ─────────────────────────────────────────────────────────────────────────
// The shared company context.
//
// One company is selected at a time and stays selected as the operator moves
// between engines — the platform's central promise. It lives here rather than
// in a route parameter so that switching engines never loses it.
//
// The list of selectable companies comes from the enrichment register, which
// is the honest answer to "which companies has this platform actually worked
// on". There is no endpoint that lists all 15,158 CRM companies, and inventing
// one in the frontend would mean the picker showed accounts no engine has
// touched.
// ─────────────────────────────────────────────────────────────────────────

export interface CompanyRef {
  crmCompanyId: string
  companyName: string | null
  /** Where this company entered the platform. */
  sourceUrl?: string | null
  technologyCount?: number
}

interface CompanyContextValue {
  company: CompanyRef | null
  companies: CompanyRef[]
  loading: boolean
  select: (company: CompanyRef | null) => void
  reload: () => void
}

const Ctx = createContext<CompanyContextValue | null>(null)
const STORAGE_KEY = 'altiusnxt.marketing.company'

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [company, setCompany] = useState<CompanyRef | null>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? (JSON.parse(raw) as CompanyRef) : null
    } catch {
      return null
    }
  })
  const [companies, setCompanies] = useState<CompanyRef[]>([])
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .get<EnrichmentList>('/enrichment')
      .then((res) => {
        if (cancelled) return
        // One entry per company, newest first — a company enriched three times
        // is one company in the picker.
        const seen = new Map<string, CompanyRef>()
        for (const row of res.enrichments ?? []) {
          if (!seen.has(row.crmCompanyId)) {
            seen.set(row.crmCompanyId, {
              crmCompanyId: row.crmCompanyId,
              companyName: row.companyName,
              sourceUrl: row.sourceUrl,
              technologyCount: row.technologyCount,
            })
          }
        }
        setCompanies([...seen.values()])
      })
      .catch(() => {
        if (!cancelled) setCompanies([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [nonce])

  const select = useCallback((next: CompanyRef | null) => {
    setCompany(next)
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* selection simply does not survive a reload */
    }
  }, [])

  const value = useMemo<CompanyContextValue>(
    () => ({ company, companies, loading, select, reload: () => setNonce((n) => n + 1) }),
    [company, companies, loading, select],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useCompany(): CompanyContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCompany must be used inside CompanyProvider')
  return ctx
}
