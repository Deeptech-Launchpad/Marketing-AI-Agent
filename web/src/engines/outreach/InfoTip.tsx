import { useEffect, useId, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { HELP, type HelpKey } from './help'

// A small (i) button that opens a short, plain explanation: what this is, and
// what to do next. Closes on Escape, on a second click, or on a click outside.

export function InfoTip({ topic, label }: { topic: HelpKey; label?: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  const id = useId()
  const help = HELP[topic]

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
    <span className="otr-info" ref={ref}>
      <button
        type="button"
        className="otr-info__btn"
        aria-label={`What is ${label ?? help.title}?`}
        aria-expanded={open}
        aria-controls={id}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((o) => !o)
        }}
      >
        <Info size={13} aria-hidden="true" />
      </button>
      {open && (
        <span id={id} role="note" className="otr-info__pop">
          <strong className="otr-info__title">{help.title}</strong>
          <span className="otr-info__what">{help.what}</span>
          {help.next && (
            <span className="otr-info__next">
              <strong>Next:</strong> {help.next}
            </span>
          )}
        </span>
      )}
    </span>
  )
}
