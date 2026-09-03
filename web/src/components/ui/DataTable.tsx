import type { ReactNode } from 'react'
import './ui.css'

// A dense, scannable table. Wide content scrolls inside its own container so
// the page body never scrolls sideways, and numeric columns line up.

export interface Column<T> {
  key: string
  header: ReactNode
  render: (row: T, index: number) => ReactNode
  /** Right-aligns and tabular-aligns the column. */
  numeric?: boolean
  width?: string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  selectedKey,
  caption,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string
  onRowClick?: (row: T) => void
  selectedKey?: string
  caption?: string
}) {
  return (
    <div className="scroll-x table-wrap">
      <table className="table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.numeric ? 'is-num' : undefined} style={c.width ? { width: c.width } : undefined}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const key = rowKey(row, i)
            const selected = selectedKey === key
            return (
              <tr
                key={key}
                className={`node-reveal${selected ? ' is-selected' : ''}${onRowClick ? ' is-clickable' : ''}`}
                style={{ ['--i' as string]: Math.min(i, 12) }}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={
                  onRowClick
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          onRowClick(row)
                        }
                      }
                    : undefined
                }
              >
                {columns.map((c) => (
                  <td key={c.key} className={c.numeric ? 'is-num tnum' : undefined}>
                    {c.render(row, i)}
                  </td>
                ))}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
