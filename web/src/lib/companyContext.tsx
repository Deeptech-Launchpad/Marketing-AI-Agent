import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from './api'
import type { EnrichmentList } from './types'
import { latestPerCompany, technologyNames } from './enrichmentSummary'

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
//
// The register alone was not enough. A company Prospect Discovery has just
// found has never been enriched, so it is absent from /enrichment: selecting
// it left the operator on the last prepared company — Jamesco — in every
// downstream engine. So a selection is authoritative on its own. It is kept
// whatever the register says, and companies chosen while absent from the
// register are remembered here alongside it so the picker can still offer
// them. The register is a source of names and counts, never the gate on what
// may be selected.
// ─────────────────────────────────────────────────────────────────────────

export interface CompanyRef {
  crmCompanyId: string
  companyName: string | null
  /** Where this company entered the platform. */
  sourceUrl?: string | null
  technologyCount?: number
  /**
   * The status of this company's latest enrichment run, from the register.
   * Absent when the company has never been enriched — which is what lets a
   * reader tell "none detected" from "never read".
   */
  enrichmentStatus?: string | null
  /** Technology names from the latest enrichment run, in stored order. */
  technologies?: string[]
  // Carried through from Prospect Discovery. A newly discovered lead has no
  // enrichment row, so these are the only facts the platform holds about it.
  // All optional, because the register does not carry them — and absent stays
  // absent: nothing here is ever inferred from a company name or a domain.
  website?: string | null
  industry?: string | null
  location?: string | null
  /** Which prospect provider surfaced it, when it came from discovery. */
  sourceProvider?: string | null
}

interface CompanyContextValue {
  company: CompanyRef | null
  companies: CompanyRef[]
  loading: boolean
  /**
   * Selects a company — including one the enrichment register has never heard
   * of. The reference given is what every engine then works from.
   */
  select: (company: CompanyRef | null) => void
  reload: () => void
}

const Ctx = createContext<CompanyContextValue | null>(null)
const STORAGE_KEY = 'altiusnxt.marketing.company'
const PICKED_KEY = 'altiusnxt.marketing.companies.picked'
/** Enough for a discovery session's worth of leads without growing forever. */
const PICKED_LIMIT = 25

export function CompanyProvider({ children }: { children: ReactNode }) {
  const [company, setCompany] = useState<CompanyRef | null>(() => readCompany(STORAGE_KEY))
  const [register, setRegister] = useState<CompanyRef[]>([])
  // Companies the operator has picked, newest first. They survive a reload so
  // a lead discovered before lunch is still in the picker afterwards.
  const [picked, setPicked] = useState<CompanyRef[]>(() => readCompanies(PICKED_KEY))
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
        for (const row of latestPerCompany(res.enrichments ?? [])) {
          seen.set(row.crmCompanyId, {
            crmCompanyId: row.crmCompanyId,
            companyName: row.companyName,
            sourceUrl: row.sourceUrl,
            technologyCount: row.technologyCount,
            enrichmentStatus: row.status,
            technologies: technologyNames(row.technologies),
          })
        }
        // Only the register is written here. The selection is deliberately
        // left alone: a register load that could reach `setCompany` is exactly
        // how a freshly discovered lead used to be swapped for a previously
        // enriched company between one engine and the next.
        setRegister([...seen.values()])
      })
      .catch(() => {
        if (!cancelled) setRegister([])
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
    // Remembered whether or not the register knows this company. Membership is
    // not testable at this moment anyway — discovery can hand us a lead before
    // /enrichment has answered, and checking against a list that has not loaded
    // would discard precisely the new lead this exists for. `companies` dedupes.
    if (next) setPicked((prev) => [next, ...prev.filter((c) => c.crmCompanyId !== next.crmCompanyId)].slice(0, PICKED_LIMIT))
    try {
      if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
      else localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* selection simply does not survive a reload */
    }
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(PICKED_KEY, JSON.stringify(picked))
    } catch {
      /* the picker falls back to the register on the next reload */
    }
  }, [picked])

  const companies = useMemo(() => {
    const merged = new Map<string, CompanyRef>()
    for (const c of picked) merged.set(c.crmCompanyId, c)
    // Belt and braces for a browser that refuses storage: whatever is selected
    // is always in the list, so the picker can never show a current company it
    // cannot offer back.
    if (company && !merged.has(company.crmCompanyId)) merged.set(company.crmCompanyId, company)
    for (const row of register) merged.set(row.crmCompanyId, withRegisterData(merged.get(row.crmCompanyId), row))
    return [...merged.values()]
  }, [register, picked, company])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  const value = useMemo<CompanyContextValue>(
    () => ({ company, companies, loading, select, reload }),
    [company, companies, loading, select, reload],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useCompany(): CompanyContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useCompany must be used inside CompanyProvider')
  return ctx
}

/**
 * One picker entry for a company that is both remembered and enriched.
 *
 * The register wins for the fields it actually holds, so the counts shown are
 * the enriched truth once enrichment has run. Discovery's fields have no
 * register column and are kept, and a null from the register does not erase a
 * value that was observed somewhere else — an empty column is not evidence
 * that there is nothing there.
 */
function withRegisterData(remembered: CompanyRef | undefined, row: CompanyRef): CompanyRef {
  if (!remembered) return row
  return {
    ...remembered,
    companyName: row.companyName ?? remembered.companyName,
    sourceUrl: row.sourceUrl ?? remembered.sourceUrl,
    technologyCount: row.technologyCount ?? remembered.technologyCount,
    // A register row is a finished observation, so its status and technology
    // list replace whatever was remembered — including an empty list.
    enrichmentStatus: row.enrichmentStatus ?? remembered.enrichmentStatus,
    technologies: row.enrichmentStatus ? row.technologies : remembered.technologies,
  }
}

/**
 * Anything without a crmCompanyId is refused.
 *
 * Every engine keys its records — and its lineage check — on that id, so a
 * half-written or outdated storage value must never become a selected company
 * that no record can be matched against.
 */
function isCompanyRef(value: unknown): value is CompanyRef {
  return typeof value === 'object' && value !== null && typeof (value as CompanyRef).crmCompanyId === 'string'
}

function readCompany(key: string): CompanyRef | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isCompanyRef(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readCompanies(key: string): CompanyRef[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isCompanyRef) : []
  } catch {
    return []
  }
}
