import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// ─────────────────────────────────────────────────────────────────────────
// Theme.
//
// Two themes, one product. Light is the default the platform opens in; dark
// is the approved futuristic environment, chosen by the viewer and remembered
// for them.
//
// The choice is stamped as `data-theme` on the document element, which is the
// single switch the whole token layer hangs off. Nothing in the interface
// asks which theme is active in order to lay itself out — only to draw on a
// canvas, where CSS cannot reach.
// ─────────────────────────────────────────────────────────────────────────

export type Theme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'altiusnxt.marketing.theme'

/** The product default. Stated once, so the answer is never two places. */
export const DEFAULT_THEME: Theme = 'light'

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark'
}

/**
 * The theme this viewer has chosen, if they have chosen one.
 *
 * A previous selection always wins: the system's `prefers-color-scheme` is a
 * hint for someone who has never chosen, never an override of someone who has.
 */
export function storedTheme(): Theme | null {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY)
    return isTheme(raw) ? raw : null
  } catch {
    // Private windows and blocked site data both throw here. A viewer who
    // cannot persist a preference still gets a working interface.
    return null
  }
}

export function resolveInitialTheme(): Theme {
  return storedTheme() ?? DEFAULT_THEME
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
}

interface ThemeValue {
  theme: Theme
  setTheme: (theme: Theme) => void
  /** True once the viewer has made an explicit choice on this device. */
  chosen: boolean
}

const ThemeContext = createContext<ThemeValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(resolveInitialTheme)
  const [chosen, setChosen] = useState(() => storedTheme() !== null)

  // The pre-paint script in index.html has already stamped the document, so
  // this only has to keep it in step with later changes.
  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  // A change made in another tab is the same person changing their mind.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return
      if (isTheme(e.newValue)) {
        setThemeState(e.newValue)
        setChosen(true)
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next)
    setChosen(true)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // The theme still applies for this session; it just will not survive it.
    }
  }, [])

  const value = useMemo(() => ({ theme, setTheme, chosen }), [theme, setTheme, chosen])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}
