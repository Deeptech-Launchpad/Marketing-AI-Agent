import { useEffect, useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import './infotip.css'

// A small (i) button that opens a short, plain explanation: what this is, and
// what to do next. Closes on Escape, on a second click, or on a click outside.

export interface HelpText {
  title: string
  what: string
  next?: string
}

export function InfoTip({ help, label }: { help: HelpText; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  return (
    <span className="infotip" ref={ref}>
      <button
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
      {open && (
        <span id={id} role="note" className="infotip__pop">
          <strong className="infotip__title">{help.title}</strong>
          <span>{help.what}</span>
          {help.next && (
            <span className="infotip__next">
              <strong>Next:</strong> {help.next}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
