import { useState } from 'react'
import { Chip, Unset } from '../../components/ui/primitives'
import { PHASE_LABEL, fmtWindow, type ProspectRow } from './types'

// EVERY PROSPECT IN THE SEQUENCE, WHAT NEEDS DOING FIRST AT THE TOP.
//
// The API orders them: overdue first, then due soonest. Ten per page.

export const PAGE_SIZE = 10

export function ProspectList({
  rows,
  selectedId,
  onSelect,
}: {
  rows: ProspectRow[]
  selectedId: string | null
  onSelect: (row: ProspectRow) => void
}) {
  const [page, setPage] = useState(1)
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  if (rows.length === 0) return <Unset what="No prospect is in the sequence yet" />

  return (
    <div className="otr-plist">
      <ul className="otr-plist__rows">
        {shown.map((r) => (
          <li key={r.campaignId}>
            <button
              type="button"
              className={`otr-plist__row${r.crmCompanyId === selectedId ? ' is-active' : ''}`}
              aria-current={r.crmCompanyId === selectedId ? 'true' : undefined}
              onClick={() => onSelect(r)}
            >
              <span className="otr-plist__name">{r.companyName}</span>
              <span className="otr-plist__sub">
                {r.contactName ?? 'No contact recorded'}
                {r.initialVersion ? ` · ${r.initialVersion.toUpperCase()}` : ''}
              </span>
              <span className="otr-plist__next">{r.next?.text ?? ''}</span>
              <span className="row">
                <Chip tone={r.phase === 'completed' ? 'ok' : r.phase === 'stopped' ? 'neutral' : r.phase === 'sales_to_reply' ? 'warn' : 'info'}>
                  {PHASE_LABEL[r.phase] ?? r.phase}
                </Chip>
                {r.next?.overdue && <Chip tone="danger">Overdue</Chip>}
                {r.pendingReplies > 0 && <Chip tone="warn">Reply to confirm</Chip>}
                {r.next?.window && <span className="cell-dim">{fmtWindow(r.next.window)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {pages > 1 && (
        <nav className="otr-pager" aria-label="Prospect pages">
          <span className="otr-pager__info">
            {(current - 1) * PAGE_SIZE + 1}–{Math.min(rows.length, current * PAGE_SIZE)} of {rows.length}
          </span>
          <button type="button" className="otr-pager__btn" disabled={current <= 1} onClick={() => setPage(current - 1)}>
            Previous
          </button>
          {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              type="button"
              className={`otr-pager__btn${p === current ? ' is-active' : ''}`}
              aria-current={p === current ? 'page' : undefined}
              aria-label={`Page ${p}`}
              onClick={() => setPage(p)}
            >
              {p}
            </button>
          ))}
          <button type="button" className="otr-pager__btn" disabled={current >= pages} onClick={() => setPage(current + 1)}>
            Next
          </button>
        </nav>
      )}
    </div>
  )
}
