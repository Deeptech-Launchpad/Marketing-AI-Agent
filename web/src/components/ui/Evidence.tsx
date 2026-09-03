import { useEffect, type ReactNode } from 'react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FileSearch, X } from 'lucide-react'
import { Button } from './primitives'
import './ui.css'

// ─────────────────────────────────────────────────────────────────────────
// Evidence.
//
// Every claim this platform makes is traceable to something it observed, and
// this is where a person checks. Each observation is laid out as a labelled
// table — source, when it was seen, which field it came from, and the literal
// fragment that proved it — because checking a claim is reading work, not
// browsing, and a reader should be able to run their eye down one column.
//
// Nothing here is generated: if the backend recorded no fragment, the panel
// says so rather than paraphrasing.
// ─────────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  /** What was observed. */
  what?: string | null
  /** Where it came from — a URL, a provider, an internal surface. */
  source?: string | null
  sourceUrl?: string | null
  /** When it was observed. */
  at?: string | null
  /** Which field the value belongs to. */
  field?: string | null
  /** The literal text that proved it. */
  fragment?: string | null
  /** How it was observed, or the rule that produced it. */
  how?: string | null
  /** The record this points at. */
  reference?: string | null
}

/** Readable to a person scanning a column, rather than a raw locale dump. */
function observedAt(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function EvidenceList({ items }: { items: EvidenceItem[] }) {
  if (!items.length) {
    return <p className="evidence__none">No evidence was recorded for this item.</p>
  }

  return (
    <ol className="evidence">
      {items.map((item, i) => {
        // Built as data so the table renders no empty rows for fields the
        // backend did not record.
        const rows: Array<{ label: string; value: ReactNode; mono?: boolean }> = []
        if (item.field) rows.push({ label: 'Field', value: item.field, mono: true })
        if (item.sourceUrl || item.source)
          rows.push({
            label: 'Source',
            value: item.sourceUrl ? (
              <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="evidence__link">
                {item.source ?? item.sourceUrl}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            ) : (
              item.source
            ),
          })
        if (item.at) rows.push({ label: 'Observed', value: observedAt(item.at), mono: true })
        if (item.how) rows.push({ label: 'How', value: item.how })
        if (item.reference) rows.push({ label: 'Record', value: item.reference, mono: true })

        return (
          <li key={i} className="evidence__item">
            {items.length > 1 && <p className="evidence__ordinal">Observation {i + 1}</p>}
            {item.what && <p className="evidence__what">{item.what}</p>}

            {rows.length > 0 && (
              <table className="evidence__table">
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.label}>
                      <th scope="row">{r.label}</th>
                      <td className={r.mono ? 'mono' : undefined}>{r.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <p className="evidence__caption">Source fragment</p>
            {item.fragment ? (
              <pre className="evidence__fragment">{item.fragment}</pre>
            ) : (
              <p className="evidence__none evidence__none--inline">
                No source fragment was stored for this observation.
              </p>
            )}
          </li>
        )
      })}
    </ol>
  )
}

/**
 * A "View evidence" affordance that opens a drawer.
 *
 * Placed next to any claim that has backing, so checking never means leaving
 * the screen you were reading.
 */
export function EvidenceButton({
  items,
  title,
  label = 'View evidence',
}: {
  items: EvidenceItem[]
  title: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="evidence-btn" onClick={() => setOpen(true)} disabled={!items.length}>
        <FileSearch size={12} aria-hidden="true" />
        {items.length ? label : 'No evidence'}
      </button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        subtitle={`${items.length} observation${items.length === 1 ? '' : 's'}`}
      >
        <EvidenceList items={items} />
      </Drawer>
    </>
  )
}

// ── Drawer ──────────────────────────────────────────────────────────────

export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  width = 520,
}: {
  open: boolean
  onClose: () => void
  title: string
  subtitle?: ReactNode
  children: ReactNode
  width?: number
}) {
  // Escape closes, and the page behind stays put while the drawer is up.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  // Rendered into the document body rather than in place.
  //
  // These triggers sit inside table cells and animated cards, and an ancestor
  // that is transformed becomes the containing block for `position: fixed` —
  // which trapped the drawer inside the cell that opened it and cropped the
  // evidence to a few characters. A portal puts it above the whole page,
  // which is where a dialog belongs anyway.
  return createPortal(
    <div className="drawer-root" role="dialog" aria-modal="true" aria-label={title}>
      <button className="drawer__scrim" onClick={onClose} aria-label="Close" />
      <aside className="drawer" style={{ width }}>
        <header className="drawer__head">
          <div className="drawer__heading">
            <h3 className="drawer__title">{title}</h3>
            {subtitle && <p className="drawer__sub">{subtitle}</p>}
          </div>
          <Button icon={X} onClick={onClose} size="sm" title="Close" />
        </header>
        <div className="drawer__body">{children}</div>
      </aside>
    </div>,
    document.body,
  )
}
