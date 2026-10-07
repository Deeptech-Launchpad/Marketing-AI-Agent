import { useCallback, useRef, useState } from 'react'

// Bulk Email's own request helper (2026-10-07): busy while a button's request
// runs, the API's own sentence if it fails, and a refresh when it succeeds.
// Bulk Email is standalone and shares no code with the other Outreach flows.

export function useBulkCall(onDone: () => void) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const run = useCallback(
    async (key: string, fn: () => Promise<unknown>): Promise<boolean> => {
      if (inFlight.current) return false
      inFlight.current = true
      setBusy(key)
      setError(null)
      try {
        await fn()
        onDone()
        return true
      } catch (err) {
        setError((err as Error)?.message || 'The request failed.')
        return false
      } finally {
        inFlight.current = false
        setBusy(null)
      }
    },
    [onDone],
  )

  return { run, busy, error }
}
