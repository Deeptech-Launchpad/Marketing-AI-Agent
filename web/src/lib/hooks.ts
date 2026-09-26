import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError } from './api'
import type { ResourceState } from './api'
import { api } from './api'
import { resolveRunId, resolveRunIdWithFallback, type CompanyRuns } from './auditLineage'

// ─────────────────────────────────────────────────────────────────────────
// Data loading, with honest states.
//
// Every request resolves into exactly one of: loading, error, or data — and
// `data` may legitimately be null, which the screens render as an empty state
// rather than as a failure. That distinction is the whole point: "nothing has
// run yet" and "something broke" look different to the person reading it.
// ─────────────────────────────────────────────────────────────────────────

export interface AsyncState<T> {
  data: T | null
  loading: boolean
  error: ApiError | Error | null
  /** Runs the request again, keeping the current data on screen meanwhile. */
  refresh: () => void
  /** True while a refresh runs over data that is already displayed. */
  refreshing: boolean
}

/**
 * Loads data for the lifetime of a screen.
 *
 * Requests are aborted when the screen unmounts or the key changes, so moving
 * quickly between engines never lands a stale response on the new page.
 */
export function useAsync<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  deps: unknown[],
  options: { enabled?: boolean } = {},
): AsyncState<T> {
  const enabled = options.enabled ?? true
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [nonce, setNonce] = useState(0)
  const hasData = useRef(false)

  useEffect(() => {
    if (!enabled) {
      setLoading(false)
      return
    }
    const controller = new AbortController()
    let cancelled = false

    if (hasData.current) setRefreshing(true)
    else setLoading(true)

    fn(controller.signal)
      .then((result) => {
        if (cancelled) return
        setData(result)
        hasData.current = true
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled || (err as Error)?.name === 'AbortError') return
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (cancelled) return
        setLoading(false)
        setRefreshing(false)
      })

    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  return { data, loading, error, refresh, refreshing }
}

/**
 * A resource, with "not built yet" kept apart from "the request failed".
 *
 * useAsync gives a screen `data` and `error`, and a null `data` used to mean
 * both "the engines have produced nothing here" and "the call blew up and we
 * know nothing" — which is how a broken endpoint came to be drawn as an audit
 * finding zero findings. This splits the two: `absent` carries the backend's
 * own sentence about what has not been built, `error` carries the failure, and
 * `data` is only ever set when something real came back.
 */
export interface ResourceAsyncState<T> {
  /** Set only when the resource is genuinely ready. Never a stand-in for absence. */
  data: T | null
  /** The backend's sentence for why nothing is here yet, when nothing is. */
  absent: string | null
  /** The envelope's code alongside `absent`, for a screen that branches on it. */
  absentCode: string | null
  error: ApiError | Error | null
  loading: boolean
  refreshing: boolean
  refresh: () => void
  /** The undivided outcome, for a screen that would rather switch on `kind`. */
  state: ResourceState<T> | null
}

/**
 * Loads one resource for the lifetime of a screen.
 *
 * `fn` returns a ResourceState — `api.resource(...)` does, and so does
 * `Promise.resolve(Resource.absent(...))` for a resource the screen already
 * knows is not built (an audit run still queued has no completed report,
 * whatever rows exist beside it).
 */
export function useResource<T>(
  fn: (signal: AbortSignal) => Promise<ResourceState<T>>,
  deps: unknown[],
  options: { enabled?: boolean } = {},
): ResourceAsyncState<T> {
  const inner = useAsync<ResourceState<T>>(fn, deps, options)
  const { data: state, loading, refreshing, refresh, error } = inner

  return useMemo(
    () => ({
      data: state?.kind === 'ready' ? state.data : null,
      absent: state?.kind === 'absent' ? state.reason : null,
      absentCode: state?.kind === 'absent' ? state.code : null,
      // A failure reported inside the outcome and one thrown past it are the
      // same thing to the person reading the screen, so both arrive here.
      error: state?.kind === 'error' ? state.error : error,
      loading,
      refreshing,
      refresh,
      state,
    }),
    [state, loading, refreshing, refresh, error],
  )
}

/**
 * Whether the viewer has asked for reduced motion.
 *
 * Read once and watched, so a change in system settings takes effect without
 * a reload. Every signature animation consults this.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return reduced
}

/**
 * Whether an element is on screen.
 *
 * Signature animations use this to stop drawing when scrolled out of view —
 * twelve engines each running a canvas loop would otherwise burn a laptop
 * battery to render pixels nobody is looking at.
 */
export function useInView<T extends Element>(options?: IntersectionObserverInit) {
  const ref = useRef<T | null>(null)
  const [inView, setInView] = useState(true)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      ([entry]) => setInView(Boolean(entry?.isIntersecting)),
      options ?? { rootMargin: '80px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { ref, inView }
}

/** Pauses work while the browser tab is hidden. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() =>
    typeof document === 'undefined' ? true : !document.hidden,
  )
  useEffect(() => {
    const onChange = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])
  return visible
}

/**
 * Calls `refresh` on an interval while `active`, and only while the tab is
 * visible.
 *
 * Every run on this platform answers 202 and is worked by a separate process
 * (src/worker.ts), so the row a person just started reads 'queued' until the
 * worker picks it up — and stays 'queued' for good if the worker is down.
 * Screens poll so a run moves QUEUED -> RUNNING -> terminal on its own, and a
 * run that never moves is visibly still waiting rather than silently zero.
 * Each screen had grown its own setInterval for this; one refreshed a hidden
 * tab every four seconds, another only started once the run was 'running',
 * which a run behind a dead worker never is. One timer, keyed on `active`.
 *
 * `refresh` is read through a ref, so an inline closure that refreshes several
 * resources does not restart the timer on every render.
 *
 * Returns whether the timer is live right now, for a screen that wants to say
 * "following this run".
 */
export function usePolling(refresh: () => void, active: boolean, intervalMs = 4000): boolean {
  const visible = usePageVisible()
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const running = active && visible

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => refreshRef.current(), intervalMs)
    return () => clearInterval(timer)
  }, [running, intervalMs])

  // Coming back to the tab reads once straight away. A run that finished
  // while the tab was hidden should not sit on its stale 'running' row for
  // another interval after the person is already looking at it.
  const wasHidden = useRef(false)
  useEffect(() => {
    if (!visible) {
      wasHidden.current = true
      return
    }
    if (wasHidden.current && active) refreshRef.current()
    wasHidden.current = false
  }, [visible, active])

  return running
}

/**
 * Drives a canvas animation, and stops it when it would not be seen.
 *
 * The loop never starts under reduced motion, and pauses when the element
 * leaves the viewport or the tab is hidden.
 */
export function useCanvasLoop(
  draw: (ctx: CanvasRenderingContext2D, t: number, w: number, h: number) => void,
  options: { active?: boolean } = {},
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const reduced = useReducedMotion()
  const visible = usePageVisible()
  const { ref: wrapRef, inView } = useInView<HTMLDivElement>()
  const drawRef = useRef(draw)
  drawRef.current = draw

  const running = (options.active ?? true) && !reduced && visible && inView

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Some environments throw here rather than returning null — jsdom does,
    // and so does a browser with canvas disabled. This canvas is decoration;
    // losing it must never take the page down with it.
    let ctx: CanvasRenderingContext2D | null = null
    try {
      ctx = canvas.getContext('2d')
    } catch {
      return
    }
    if (!ctx) return

    let frame = 0
    let start = performance.now()

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return rect
    }

    let rect = resize()
    const observer = new ResizeObserver(() => {
      rect = resize()
      if (!running) drawRef.current(ctx, 0, rect.width, rect.height)
    })
    observer.observe(canvas)

    if (!running) {
      // Draw one static frame so the visual still reads as itself.
      drawRef.current(ctx, 0, rect.width, rect.height)
      return () => observer.disconnect()
    }

    const tick = (now: number) => {
      drawRef.current(ctx, (now - start) / 1000, rect.width, rect.height)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [running])

  return { canvasRef, wrapRef, running }
}

/**
 * A manual engine action: run it, then refresh what it produced.
 *
 * Every executable engine on this platform has the same shape — POST a company
 * reference, the backend queues real work, then the page re-reads. This holds
 * the four states that shape has (idle, running, failed, ran-at) in one place
 * so each engine does not invent its own, and so a second click cannot fire
 * while the first is still in flight.
 *
 * It computes nothing about the result. What the engine produced is read back
 * from the API, exactly as before.
 */
export function useEngineAction(run: () => Promise<void>): {
  fire: () => void
  running: boolean
  error: ApiError | Error | null
  ranAt: Date | null
} {
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<ApiError | Error | null>(null)
  const [ranAt, setRanAt] = useState<Date | null>(null)
  const inFlight = useRef(false)

  const fire = useCallback(() => {
    // Guarded by a ref as well as by state: two clicks in the same tick would
    // both see `running` as false and both dispatch.
    if (inFlight.current) return
    inFlight.current = true
    setRunning(true)
    setError(null)
    void run()
      .then(() => setRanAt(new Date()))
      .catch((err: unknown) => setError(err as Error))
      .finally(() => {
        inFlight.current = false
        setRunning(false)
      })
  }, [run])

  return { fire, running, error, ranAt }
}

/**
 * The audit run a screen should open for the company selected in Shared Context.
 *
 * Three sources, in order: a `?run=` parameter, this browser's memory of the
 * company's last run, and — the one added here — the company's own runs from
 * the server. Without the third, selecting a company that had already been
 * audited showed "No audit run open" on the Audit, Report, Approval and
 * Workbench screens, because the remembered run lives in localStorage and a
 * colleague, a different machine or a fresh profile has none. A company with
 * three completed audits read exactly like a company nobody had ever audited.
 *
 * The server decides which run is openable, and only ever offers one that
 * inspected pages, so this cannot resolve to a queued or empty run and let a
 * zero-valued report be drawn from it. The lookup is skipped entirely when the
 * first two sources already answered.
 */
export function useResolvedRunId(
  params: URLSearchParams,
  crmCompanyId: string | null | undefined,
): { runId: string | null; resolving: boolean; runs: CompanyRuns | null; refresh: () => void } {
  const direct = resolveRunId(params, crmCompanyId)

  const listed = useAsync<CompanyRuns | null>(
    (signal) =>
      crmCompanyId
        ? api.get(`/website-audit/companies/${crmCompanyId}/runs`, { signal, nullOn404: true })
        : Promise.resolve(null),
    [crmCompanyId],
    { enabled: Boolean(crmCompanyId) && !direct },
  )

  const runId = useMemo(
    () => resolveRunIdWithFallback(params, crmCompanyId, listed.data),
    [params, crmCompanyId, listed.data],
  )

  return { runId, resolving: !direct && listed.loading, runs: listed.data, refresh: listed.refresh }
}
