import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError } from './api'

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
    const ctx = canvas.getContext('2d')
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
