import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Info } from 'lucide-react'
import './infotip.css'

// A small (i) button that opens a short, plain explanation: what this is, and
// what to do next. Closes on Escape, on a second click, on a click outside, or
// when the page scrolls or resizes.
//
// The explanation is drawn in a layer above the whole page (a portal on
// <body>, fixed-positioned under the button). Drawn inside its container it
// was cut off by any card that hides its overflow — the engine header does.

export interface HelpText {
  title: string
  what: string
  next?: string
}

const POP_WIDTH = 320
const GAP = 6
const EDGE = 8

export function InfoTip({ help, label }: { help: HelpText; label?: string }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLSpanElement>(null)
  const id = useId()

  // Place it under the button, kept inside the window.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const width = Math.min(POP_WIDTH, window.innerWidth - EDGE * 2)
    const left = Math.max(EDGE, Math.min(r.left - EDGE, window.innerWidth - width - EDGE))
    setPos({ top: r.bottom + GAP, left, width })
  }, [open])

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', close)
    // Capture: any scrolling container, not just the window.
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('scroll', close, true)
    }
  }, [open])

  return (
    <span className="infotip">
      <button
        ref={btnRef}
        type="button"
        className="infotip__btn"
        aria-label={`What is ${label ?? help.title}?`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <span
            id={id}
            ref={popRef}
            role="note"
            className="infotip__pop"
            style={pos ? { top: pos.top, left: pos.left, width: pos.width } : { visibility: 'hidden' }}
          >
            <strong className="infotip__title">{help.title}</strong>
            <span>{help.what}</span>
            {help.next && (
              <span className="infotip__next">
                <strong>Next:</strong> {help.next}
              </span>
            )}
          </span>,
          document.body,
        )}
    </span>
  )
}
