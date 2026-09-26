import { useEffect, type ReactNode } from 'react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ExternalLink, FileSearch, X } from 'lucide-react'
import { Button } from './primitives'
import './ui.css'
import './evidence-summary.css'

// ─────────────────────────────────────────────────────────────────────────
// Evidence.
//
// Every claim this platform makes is traceable to something it observed, and
// this is where a person checks. An observation opens with the reading a
// person actually needs — what was detected, what it means, where it came
// from — and keeps the literal fragment behind a fold underneath. Checking a
// claim used to begin with a wall of raw markup, which asked the reader to
// reconstruct the finding for themselves before they could agree with it.
//
// The explained layout only applies to items whose caller recorded a summary.
// Everything else falls through to the original as-recorded table, so no
// screen changes because of this file alone.
//
// Nothing here is generated: if the backend recorded no fragment the panel
// says so rather than paraphrasing, and a summary is only ever the caller's
// own words — never inferred from a name, a domain, or a similar record.
// ─────────────────────────────────────────────────────────────────────────

export interface EvidenceItem {
  /** Headline for what was detected. Falls back to `what` when absent. */
  title?: string | null
  /**
   * A plain-English reading of the observation. Its presence is what selects
   * the explained layout, so an item without one renders as it always has.
   */
  summary?: string | null
  /** What the summary means for the reader, when the caller knows. */
  whyItMatters?: string | null
  /**
   * How a seller could OPEN on this, when the caller has one.
   *
   * Rendered separately from whyItMatters, and labelled as a suggestion,
   * because one is about the company and the other is about our words. A
   * reader is entitled to reject the second without doubting the first, and
   * that is only possible if the two are never run together.
   */
  outreachAngle?: string | null
  /** What was observed. */
  what?: string | null
  /** Where it came from — a URL, a provider, an internal surface. */
  source?: string | null
  sourceUrl?: string | null
  /** When it was observed. */
  at?: string | null
  /** The same instant under the name some records carry it as. */
  observedAt?: string | null
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
function formatObserved(at: string): string {
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

type MetaRow = { label: string; value: ReactNode; mono?: boolean }

/** A real link whenever a URL was recorded, so the source can be opened. */
function sourceCell(item: EvidenceItem): ReactNode {
  return item.sourceUrl ? (
    <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer" className="evidence__link">
      {item.source ?? item.sourceUrl}
      <ExternalLink size={11} aria-hidden="true" />
    </a>
  ) : (
    item.source
  )
}

/** Built from rows the caller pushed, so no field the backend never recorded
    leaves an empty row behind. */
function MetaTable({ rows, className }: { rows: MetaRow[]; className?: string }) {
  if (!rows.length) return null
  return (
    <table className={className ? `evidence__table ${className}` : 'evidence__table'}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row">{r.label}</th>
            <td className={r.mono ? 'mono' : undefined}>{r.value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * The explained layout: summary first, raw evidence underneath.
 *
 * The order matters more than anything else here — a reader who has to start
 * with the fragment ends up trusting the claim instead of checking it.
 */
function ExplainedObservation({ item }: { item: EvidenceItem }) {
  const when = item.at ?? item.observedAt ?? null

  const rows: MetaRow[] = []
  if (item.sourceUrl || item.source) rows.push({ label: 'Source', value: sourceCell(item) })
  if (when) rows.push({ label: 'Observed', value: formatObserved(when), mono: true })
  if (item.field) rows.push({ label: 'Field', value: item.field, mono: true })

  // `what` is the raw observed statement. It only earns its own line when the
  // caller also gave a title — otherwise it *is* the title, and repeating it
  // under the summary reads as two separate findings.
  const observed = item.title && item.what && item.what !== item.title ? item.what : null
  const heading = item.title ?? item.what
  const hasObservedData = Boolean(observed || item.fragment)

  return (
    <>
      {heading && <h4 className="evidence-summary__title">{heading}</h4>}
      <p className="evidence-summary__text">{item.summary}</p>

      {item.whyItMatters && (
        <p className="evidence-summary__why">
          <span className="evidence-summary__whylabel">Why it matters</span>
          {item.whyItMatters}
        </p>
      )}

      {item.outreachAngle && (
        <p className="evidence-summary__why evidence-summary__why--angle">
          <span className="evidence-summary__whylabel">Outreach angle</span>
          {item.outreachAngle}
        </p>
      )}

      <MetaTable rows={rows} className="evidence-summary__meta" />

      {hasObservedData ? (
        <details className="evidence-summary__raw">
          <summary>Observed data</summary>
          <div className="evidence-summary__rawbody">
            {observed && <p className="evidence-summary__observed">{observed}</p>}
            {item.fragment && <pre className="evidence__fragment">{item.fragment}</pre>}
          </div>
        </details>
      ) : (
        // An absence is never folded away: a reader should not have to open
        // something to find out that nothing was stored behind it.
        <div className="evidence-summary__missing">
          <p className="evidence__caption">Observed data</p>
          <p className="evidence__none evidence__none--inline">
            No source fragment was stored for this observation.
          </p>
        </div>
      )}

      {(item.how || item.reference) && (
        <div>
          <p className="evidence__caption">How it was detected</p>
          {item.how && <p className="evidence-summary__how">{item.how}</p>}
          {item.reference && <p className="evidence-summary__ref mono">Record {item.reference}</p>}
        </div>
      )}
    </>
  )
}

/**
 * The as-recorded layout, unchanged.
 *
 * Every item whose caller stored no summary still renders the labelled table
 * and the fragment, in the order they were always in.
 */
function RecordedObservation({ item }: { item: EvidenceItem }) {
  const when = item.at ?? item.observedAt ?? null

  const rows: MetaRow[] = []
  if (item.field) rows.push({ label: 'Field', value: item.field, mono: true })
  if (item.sourceUrl || item.source) rows.push({ label: 'Source', value: sourceCell(item) })
  if (when) rows.push({ label: 'Observed', value: formatObserved(when), mono: true })
  if (item.how) rows.push({ label: 'How', value: item.how })
  if (item.reference) rows.push({ label: 'Record', value: item.reference, mono: true })

  return (
    <>
      {item.what && <p className="evidence__what">{item.what}</p>}

      <MetaTable rows={rows} />

      <p className="evidence__caption">Source fragment</p>
      {item.fragment ? (
        <pre className="evidence__fragment">{item.fragment}</pre>
      ) : (
        <p className="evidence__none evidence__none--inline">
          No source fragment was stored for this observation.
        </p>
      )}
    </>
  )
}

export function EvidenceList({ items }: { items: EvidenceItem[] }) {
  if (!items.length) {
    return <p className="evidence__none">No reference was recorded for this item.</p>
  }

  return (
    <ol className="evidence">
      {items.map((item, i) => (
        <li key={i} className="evidence__item">
          {items.length > 1 && <p className="evidence__ordinal">Observation {i + 1}</p>}
          {item.summary ? <ExplainedObservation item={item} /> : <RecordedObservation item={item} />}
        </li>
      ))}
    </ol>
  )
}

/**
 * A "View reference" affordance that opens a drawer.
 *
 * Placed next to any claim that has backing, so checking never means leaving
 * the screen you were reading.
 */
export function EvidenceButton({
  items,
  title,
  label = 'View reference',
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
        {items.length ? label : 'No reference'}
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
