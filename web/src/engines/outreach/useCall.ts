import { useCallback, useRef, useState } from 'react'

// One button's request: busy while it runs, the API's own sentence if it
// fails, and a refresh of the workspace when it succeeds. The error is shown
// as the backend wrote it — "This email cannot be approved yet: …" is more
// useful to Sales than anything the screen could paraphrase.

export function useCall(onDone: () => void) {
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

  return { run, busy, error, clearError: () => setError(null) }
}
