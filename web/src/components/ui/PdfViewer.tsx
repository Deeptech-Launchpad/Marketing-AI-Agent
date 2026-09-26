import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, Maximize2, Minimize2, Minus, MoveHorizontal, Plus } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { Button } from './primitives'
import { BlockedState, ErrorState, LoadingState } from './states'
import './pdfviewer.css'

// ─────────────────────────────────────────────────────────────────────────
// The PDF, drawn by us.
//
// The customer document used to be handed to an <iframe> as a blob URL, which
// makes the browser's own PDF plug-in responsible for showing it. A browser
// configured to DOWNLOAD PDFs rather than display them renders that frame as
// an empty box — so the one artefact the audit engine produces was invisible
// on exactly the machines most likely to be looking at it, with nothing on
// screen to say why.
//
// This renders every page onto a canvas with PDF.js instead. The pages are
// ours: they appear the same way on every browser, they cannot be silently
// swallowed by a download setting, and when the bytes will not parse the
// reader is told so in words rather than shown a blank rectangle.
// ─────────────────────────────────────────────────────────────────────────

/** Zoom stops, so the buttons step through sensible sizes rather than drift. */
const ZOOM_STEPS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 2.5, 3] as const
const MIN_SCALE = 0.25
const MAX_SCALE = 4
/** Breathing room either side of a page inside the scroller, in CSS pixels. */
const GUTTER = 24

type PdfjsModule = typeof import('pdfjs-dist')

let pdfjsLoad: Promise<PdfjsModule> | null = null

/**
 * Loads PDF.js once per session, with its worker wired up.
 *
 * Two things here are deliberate.
 *
 *   · The import is DYNAMIC. PDF.js is a large library that only this viewer
 *     needs, and it is only reached once we know the environment can give us a
 *     2D canvas — which keeps it off the bundle's critical path and out of
 *     test environments that cannot run it at all.
 *   · The worker source is set. Left unset, PDF.js v4 either fails outright or
 *     parses on the main thread, which locks the interface for the length of
 *     the document. The `?url` form lets Vite emit and fingerprint the worker
 *     file, so the path is right in dev and in a production build alike.
 */
function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsLoad) {
    pdfjsLoad = (async () => {
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ])
      lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    })().catch((err: unknown) => {
      // A cached rejected promise would make one bad network moment permanent
      // for the rest of the session, so the next mount gets a fresh attempt.
      pdfjsLoad = null
      throw err
    })
  }
  return pdfjsLoad
}

let canvas2dOk: boolean | null = null

/**
 * Whether this environment can actually draw on a canvas.
 *
 * jsdom THROWS from getContext rather than returning null (the same guard, for
 * the same reason, is in lib/hooks.ts), and a browser with canvas disabled
 * returns null. Either way there is no point loading PDF.js: the viewer says
 * so instead of mounting a renderer that cannot render.
 *
 * Answered once per session, because the answer cannot change and because in
 * jsdom every call logs a "Not implemented" line — one per mount would bury a
 * test run's real output.
 */
function canvas2dSupported(): boolean {
  if (canvas2dOk !== null) return canvas2dOk
  if (typeof document === 'undefined') return (canvas2dOk = false)
  try {
    const probe = document.createElement('canvas')
    canvas2dOk = typeof probe.getContext === 'function' && probe.getContext('2d') != null
  } catch {
    canvas2dOk = false
  }
  return canvas2dOk
}

/**
 * Turns a PDF.js exception into a sentence a reader can act on.
 *
 * PDF.js names its failures precisely, but "Invalid PDF structure" on its own
 * still leaves somebody wondering whether the viewer or the file is at fault.
 */
function describeFailure(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err))
  switch (e.name) {
    case 'PasswordException':
      return new Error(
        'This PDF is password protected, so its pages cannot be drawn here. Download the file and open it with the password.',
      )
    case 'InvalidPDFException':
      return new Error(
        `The bytes that arrived are not a readable PDF (${e.message}). They have not been rendered, because a blank page would have read as an empty report.`,
      )
    case 'MissingPDFException':
      return new Error('The response carried no PDF data, so there is nothing to draw.')
    case 'UnexpectedResponseException':
      return new Error(`The PDF could not be read: ${e.message}`)
    default:
      return e
  }
}

function clampScale(v: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, v))
}

/** A page's own size in CSS pixels at scale 1, rotation already applied. */
interface PageSize {
  width: number
  height: number
}

/** One shared empty array, so a non-ready render does not invalidate every memo. */
const EMPTY_PAGES: PageSize[] = []

type ViewerState =
  | { kind: 'loading' }
  /** No 2D canvas in this environment — stated, never silently blank. */
  | { kind: 'unsupported' }
  | { kind: 'ready'; pages: PageSize[] }
  | { kind: 'failed'; error: Error }

export interface PdfViewerProps {
  /**
   * The document itself. Held by the CALLER, because the caller owns the
   * authenticated request that produced it.
   *
   * Treated as immutable, and identity-compared: a new object reloads the
   * document, so pass a stable reference (useState / useMemo) rather than a
   * fresh view built during render.
   */
  bytes: ArrayBuffer | Uint8Array
  /** Shown in the toolbar and used as the page region's accessible name. */
  fileName: string
  /**
   * Invoked by the Download control. The viewer never fetches anything itself:
   * these endpoints are authenticated, and on this platform downloading a
   * customer report also mints a share code — an act the caller must own.
   * Omit it and no download control is offered.
   */
  onDownload?: () => void
  /** Optional extra classes on the viewer root. */
  className?: string
}

export function PdfViewer({ bytes, fileName, onDownload, className }: PdfViewerProps) {
  const [state, setState] = useState<ViewerState>({ kind: 'loading' })
  const [mode, setMode] = useState<'fit' | 'zoom'>('fit')
  const [zoomScale, setZoomScale] = useState(1)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pageElsRef = useRef<(HTMLDivElement | null)[]>([])
  const canvasesRef = useRef<(HTMLCanvasElement | null)[]>([])
  const docRef = useRef<PDFDocumentProxy | null>(null)
  // Every render task currently in flight, so unmount can cancel work that a
  // single effect's cleanup would otherwise miss. A render task left running
  // holds its canvas and its page alive — a real leak on a screen an operator
  // opens in the morning and never closes.
  const tasksRef = useRef<Set<RenderTask>>(new Set())

  const cancelAllRenders = useCallback(() => {
    for (const task of tasksRef.current) {
      try {
        task.cancel()
      } catch {
        /* Already finished or already cancelled; nothing to undo. */
      }
    }
    tasksRef.current.clear()
  }, [])

  // Capped at 2 for the same reason as every other canvas on this platform:
  // past that, the memory a full-page bitmap costs outruns what the eye gets
  // back, and a 3x display would allocate more than twice the pixels.
  const dpr = useMemo(() => {
    if (typeof window === 'undefined') return 1
    return Math.min(window.devicePixelRatio || 1, 2)
  }, [])

  // ── Load the document ─────────────────────────────────────────────────
  useEffect(() => {
    if (!canvas2dSupported()) {
      setState({ kind: 'unsupported' })
      return
    }

    let cancelled = false
    let task: PDFDocumentLoadingTask | null = null
    setState({ kind: 'loading' })
    setCurrentPage(1)
    pageElsRef.current = []
    canvasesRef.current = []

    void (async () => {
      const lib = await loadPdfjs()
      if (cancelled) return

      // PDF.js TRANSFERS the buffer it is handed to its worker, which detaches
      // it. The caller's copy would then be a zero-length husk, and a second
      // mount — a retry, or React 18's development double-invoke — would fail
      // on bytes that were perfectly good. So it gets a copy of its own.
      const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes.slice(0))

      task = lib.getDocument({ data, isEvalSupported: false })
      const doc = await task.promise
      if (cancelled) {
        void doc.destroy().catch(() => undefined)
        return
      }

      // Measured up front so every page box can be laid out at its true aspect
      // ratio before a pixel is drawn: pages that resize as they render make
      // the scroll position jump under the reader's cursor.
      const sizes: PageSize[] = []
      for (let n = 1; n <= doc.numPages; n += 1) {
        const page = await doc.getPage(n)
        if (cancelled) {
          void doc.destroy().catch(() => undefined)
          return
        }
        const vp = page.getViewport({ scale: 1 })
        sizes.push({ width: vp.width, height: vp.height })
      }

      docRef.current = doc
      setState({ kind: 'ready', pages: sizes })
    })().catch((err: unknown) => {
      if (cancelled) return
      setState({ kind: 'failed', error: describeFailure(err) })
    })

    return () => {
      cancelled = true
      // Renders first, then the document. Destroying a document out from under
      // a live render task is what produces the "canvas is already in use"
      // noise in the console, and leaves that task holding its page.
      cancelAllRenders()
      const doc = docRef.current
      docRef.current = null
      // destroy() rejects whatever load is still in flight. That rejection is
      // the expected outcome of unmounting, not a failure to report.
      void doc?.destroy().catch(() => undefined)
      void task?.destroy().catch(() => undefined)
    }
  }, [bytes, cancelAllRenders])

  // ── Track the width available to a page ───────────────────────────────
  //
  // Fit-width is not a one-off measurement: the shell's context sidebar
  // collapses, the window resizes, and fullscreen changes the box entirely.
  // Each of those has to re-scale AND re-rasterise, or the pages stay sharp at
  // yesterday's width and blurry at today's.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return

    const measure = () => {
      const width = el.clientWidth
      // Sub-pixel churn would re-rasterise every page for nothing.
      setViewportWidth((prev) => (Math.abs(prev - width) < 1 ? prev : width))
    }
    measure()

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [state.kind])

  const pages = state.kind === 'ready' ? state.pages : EMPTY_PAGES

  // The widest page sets fit-width, so a landscape page inside a portrait
  // document fits too rather than being clipped by the pages around it.
  const widestPage = useMemo(() => pages.reduce((max, p) => Math.max(max, p.width), 0), [pages])

  const fitScale = useMemo(() => {
    if (!widestPage || viewportWidth <= 0) return 0
    return clampScale((viewportWidth - GUTTER * 2) / widestPage)
  }, [widestPage, viewportWidth])

  // Zero means "not measured yet", and suppresses rendering entirely: drawing
  // at a guessed scale and redrawing at the real one is a visible flash.
  const renderScale = mode === 'fit' ? fitScale : zoomScale

  // ── Draw the pages ────────────────────────────────────────────────────
  useEffect(() => {
    if (state.kind !== 'ready') return
    const doc = docRef.current
    if (!doc || renderScale <= 0) return

    let cancelled = false
    const started: RenderTask[] = []

    void (async () => {
      for (let n = 1; n <= state.pages.length; n += 1) {
        if (cancelled) return
        const canvas = canvasesRef.current[n - 1]
        if (!canvas) continue

        let ctx: CanvasRenderingContext2D | null = null
        try {
          ctx = canvas.getContext('2d')
        } catch {
          ctx = null
        }
        if (!ctx) {
          // The probe passed but this canvas will not draw. Say so, rather than
          // leaving the reader with page boxes that never fill in.
          setState({ kind: 'unsupported' })
          return
        }

        const page = await doc.getPage(n)
        if (cancelled) return

        // The backing store is the CSS size times the device pixel ratio, and
        // the CSS size comes from the wrapper below. That is what makes the
        // type crisp on a retina display instead of an upscaled 1x bitmap.
        const viewport = page.getViewport({ scale: renderScale * dpr })
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))

        const task = page.render({ canvasContext: ctx, viewport })
        started.push(task)
        tasksRef.current.add(task)
        try {
          await task.promise
        } catch (err) {
          tasksRef.current.delete(task)
          // Cancellation is how a scale change stops the previous pass. It is
          // the mechanism working, not a failure to show anybody.
          if ((err as Error | undefined)?.name === 'RenderingCancelledException') return
          throw err
        }
        tasksRef.current.delete(task)
      }
    })().catch((err: unknown) => {
      if (cancelled) return
      setState({ kind: 'failed', error: describeFailure(err) })
    })

    return () => {
      cancelled = true
      for (const task of started) {
        try {
          task.cancel()
        } catch {
          /* Already settled. */
        }
        tasksRef.current.delete(task)
      }
    }
  }, [state, renderScale, dpr])

  // ── Which page the reader is actually looking at ──────────────────────
  useEffect(() => {
    const el = scrollRef.current
    if (!el || state.kind !== 'ready') return

    let frame = 0
    const update = () => {
      frame = 0
      // A third of the way down the viewport: the page filling most of the
      // screen is the one named, rather than whichever happens to be touching
      // the top edge.
      const probe = el.scrollTop + el.clientHeight * 0.35
      let n = 1
      for (let i = 0; i < pageElsRef.current.length; i += 1) {
        const box = pageElsRef.current[i]
        if (!box) continue
        if (box.offsetTop <= probe) n = i + 1
        else break
      }
      setCurrentPage(n)
    }
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(update)
    }

    update()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [state])

  // ── Fullscreen ────────────────────────────────────────────────────────
  const fullscreenSupported = useMemo(
    () => typeof document !== 'undefined' && Boolean(document.fullscreenEnabled),
    [],
  )

  useEffect(() => {
    if (!fullscreenSupported) return
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [fullscreenSupported])

  const toggleFullscreen = useCallback(() => {
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement) {
      void document.exitFullscreen?.().catch(() => undefined)
      return
    }
    void root.requestFullscreen?.().catch(() => undefined)
  }, [])

  // ── Zoom ──────────────────────────────────────────────────────────────
  //
  // Both steps read from renderScale rather than from zoomScale, so the first
  // click after fit-width moves from the size on screen. Stepping from a stale
  // 100% would jump the page instead of nudging it.
  const zoomOut = useCallback(() => {
    const from = renderScale > 0 ? renderScale : 1
    const next = [...ZOOM_STEPS].reverse().find((s) => s < from - 0.01) ?? MIN_SCALE
    setMode('zoom')
    setZoomScale(clampScale(next))
  }, [renderScale])

  const zoomIn = useCallback(() => {
    const from = renderScale > 0 ? renderScale : 1
    const next = ZOOM_STEPS.find((s) => s > from + 0.01) ?? MAX_SCALE
    setMode('zoom')
    setZoomScale(clampScale(next))
  }, [renderScale])

  const fitToWidth = useCallback(() => setMode('fit'), [])

  const ready = state.kind === 'ready'
  const zoomLabel = renderScale > 0 ? `${Math.round(renderScale * 100)}%` : '—'

  return (
    <div ref={rootRef} className={`pdfv${fullscreen ? ' pdfv--full' : ''}${className ? ` ${className}` : ''}`}>
      <div className="pdfv__bar">
        <div className="pdfv__where">
          <span className="pdfv__name" title={fileName}>
            {fileName}
          </span>
          {/* Announced politely rather than assertively: this changes on every
              scroll, and an assertive region would interrupt a screen reader
              continuously while the reader pages through the document. */}
          <span className="pdfv__pages tnum" role="status" aria-live="polite">
            {ready ? `Page ${currentPage} of ${pages.length}` : 'Page — of —'}
          </span>
        </div>

        <div className="pdfv__tools">
          <Button icon={Minus} variant="quiet" size="sm" title="Zoom out" onClick={zoomOut} disabled={!ready} />
          <span className="pdfv__zoom tnum">{zoomLabel}</span>
          <Button icon={Plus} variant="quiet" size="sm" title="Zoom in" onClick={zoomIn} disabled={!ready} />
          <span className={mode === 'fit' ? 'pdfv__toggle pdfv__toggle--on' : 'pdfv__toggle'}>
            <Button
              icon={MoveHorizontal}
              variant="quiet"
              size="sm"
              title="Fit the page to the width of the viewer"
              onClick={fitToWidth}
              disabled={!ready}
            >
              Fit width
            </Button>
          </span>
          {fullscreenSupported && (
            <Button
              icon={fullscreen ? Minimize2 : Maximize2}
              variant="quiet"
              size="sm"
              title={fullscreen ? 'Leave full screen' : 'Read full screen'}
              onClick={toggleFullscreen}
            />
          )}
          {onDownload && (
            <Button icon={Download} variant="ghost" size="sm" title={`Download ${fileName}`} onClick={onDownload}>
              Download
            </Button>
          )}
        </div>
      </div>

      {/* tabIndex makes the pages keyboard-scrollable. A canvas carries no text
          for a screen reader, so the region is labelled with the file name and
          each page box names itself — the document is still reachable, and the
          download control is the honest route to its contents. */}
      <div className="pdfv__scroll" ref={scrollRef} tabIndex={0} aria-label={fileName} role="region">
        {state.kind === 'loading' && (
          <div className="pdfv__notice">
            <LoadingState what="Rendering the document, page by page" rows={2} />
          </div>
        )}

        {state.kind === 'unsupported' && (
          <div className="pdfv__notice">
            <BlockedState
              what="This browser will not draw the pages"
              why="The viewer renders each page onto a 2D canvas, and this environment does not provide one, so nothing has been drawn. An empty frame here would have read as an empty report."
              affects="Only the preview on this screen. The document itself is intact and unchanged."
              remediation={
                onDownload
                  ? 'Download the file and open it in a PDF reader, or enable canvas in this browser.'
                  : 'Enable canvas in this browser, or open the file in a PDF reader.'
              }
            />
          </div>
        )}

        {state.kind === 'failed' && (
          <div className="pdfv__notice">
            <ErrorState
              error={state.error}
              what="The document could not be rendered"
              affects="Only this preview. The bytes arrived; they could not be read as a PDF."
            />
          </div>
        )}

        {ready &&
          pages.map((size, i) => {
            // A zero scale means the width has not been measured yet. The box
            // still reserves the page's aspect ratio, so the scroller does not
            // lurch when the first pass lands.
            const cssWidth = renderScale > 0 ? Math.round(size.width * renderScale) : 0
            const cssHeight = renderScale > 0 ? Math.round(size.height * renderScale) : 0
            return (
              <div
                key={i}
                className="pdfv__page"
                ref={(el) => {
                  pageElsRef.current[i] = el
                }}
                style={
                  cssWidth > 0
                    ? { width: `${cssWidth}px`, height: `${cssHeight}px` }
                    : { width: '100%', aspectRatio: `${size.width} / ${size.height}` }
                }
                aria-label={`Page ${i + 1} of ${pages.length}`}
              >
                <canvas
                  className="pdfv__canvas"
                  ref={(el) => {
                    canvasesRef.current[i] = el
                  }}
                />
              </div>
            )
          })}
      </div>
    </div>
  )
}
