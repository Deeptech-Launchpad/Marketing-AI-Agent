import { useState } from 'react'
import { api } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { Button, Chip, Panel } from '../../components/ui/primitives'
import { DataTable } from '../../components/ui/DataTable'
import { ErrorState, LoadingState } from '../../components/ui/states'
import { EvaluationCard } from './EvaluationCard'
import { FILTERS, fmt, num, statusOf } from './labels'
import type { CompanyRow, Evaluation, Filter } from './types'

const PAGE = 25

/** Every NXT Sales company with its current status. Click one to see its score, evidence and source links. */
export function CompanyList({ refreshKey, initialFilter = 'all' }: { refreshKey: number; initialFilter?: Filter }) {
  const [filter, setFilter] = useState<Filter>(initialFilter)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)

  const list = useAsync<{ total: number; page: number; limit: number; items: CompanyRow[] }>(
    (signal) => api.get(`/warm-leads/companies?filter=${filter}&page=${page}&limit=${PAGE}${query ? `&search=${encodeURIComponent(query)}` : ''}`, { signal }),
    [filter, page, query, refreshKey],
  )
  const detail = useAsync<{ company: CompanyRow; history: Evaluation[] }>(
    (signal) => api.get(`/warm-leads/companies/${encodeURIComponent(open!)}`, { signal }),
    [open, refreshKey],
    { enabled: Boolean(open) },
  )
  const pages = list.data ? Math.max(1, Math.ceil(list.data.total / PAGE)) : 1

  return (
    <Panel
      title="Companies"
      subtitle="Every company in NXT Sales with its current status. Highest score first."
      actions={
        <form
          className="row"
          style={{ gap: 'var(--s2)' }}
          onSubmit={(e) => {
            e.preventDefault()
            setPage(1)
            setQuery(search.trim())
          }}
        >
          <select aria-label="Show" value={filter} onChange={(e) => { setFilter(e.target.value as Filter); setPage(1) }}>
            {FILTERS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
          <input aria-label="Search by name or website" placeholder="Search name or website" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 200 }} />
          <Button type="submit" size="sm">Search</Button>
        </form>
      }
    >
      {!list.data ? (
        list.error ? <ErrorState error={list.error} what="The companies could not be read" onRetry={list.refresh} /> : <LoadingState what="Reading the companies" />
      ) : list.data.items.length === 0 ? (
        <p className="note">No company matches. {filter === 'all' && !query ? 'Read the company list from NXT Sales first.' : ''}</p>
      ) : (
        <>
          <DataTable<CompanyRow>
            caption="Warm-lead companies"
            rows={list.data!.items}
            rowKey={(c) => c.crmCompanyId}
            selectedKey={open ?? undefined}
            onRowClick={(c) => setOpen(c.crmCompanyId === open ? null : c.crmCompanyId)}
            columns={[
              { key: 'name', header: 'Company', render: (c) => <strong>{c.name}</strong> },
              { key: 'status', header: 'Status', render: (c) => { const s = statusOf(c); return <Chip tone={s.tone}>{s.label}</Chip> } },
              { key: 'score', header: 'Score', numeric: true, render: (c) => (c.score != null ? c.score : '—') },
              { key: 'conf', header: 'Confidence', render: (c) => c.confidence ?? '—' },
              { key: 'where', header: 'Country', render: (c) => c.country ?? '—' },
              { key: 'site', header: 'Website', render: (c) => c.domain ?? '—' },
              { key: 'when', header: 'Last evaluated', render: (c) => fmt(c.evaluatedAt) },
              { key: 'crm', header: 'In NXT Sales', render: (c) => (c.syncedEvaluationId ? 'Yes' : c.syncError ? 'Error' : '—') },
            ]}
          />
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 'var(--s3)' }}>
            <span className="note">{num(list.data!.total)} companies · page {page} of {pages}</span>
            <span className="row" style={{ gap: 'var(--s2)' }}>
              <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <Button size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</Button>
            </span>
          </div>
        </>
      )}

      {open && (
        <div style={{ marginTop: 'var(--s4)', display: 'grid', gap: 'var(--s3)' }}>
          {!detail.data ? (
            detail.error ? <ErrorState error={detail.error} what="This company could not be read" onRetry={detail.refresh} /> : <LoadingState what="Reading this company" />
          ) : (
            <>
              <h3 style={{ margin: 0 }}>{detail.data!.company.name}</h3>
              {detail.data!.company.lastError && <p className="note note--caveat">{detail.data!.company.lastError}</p>}
              {detail.data!.company.syncError && <p className="note note--caveat">Not in NXT Sales: {detail.data!.company.syncError}</p>}
              <p className="note">
                {detail.data!.company.nextAttemptAt && detail.data!.company.state !== 'evaluated' ? `Next automatic attempt ${fmt(detail.data!.company.nextAttemptAt)}. ` : ''}
                Attempts: {detail.data!.company.attempts}. Every evaluation below is kept as history; the newest completed one is the company’s current result.
              </p>
              {detail.data!.history.length === 0 ? (
                <p className="note">This company has not been evaluated yet.</p>
              ) : (
                detail.data!.history.map((e, i) => (
                  <EvaluationCard key={e.id} e={e} heading={i === 0 ? 'Latest evaluation' : `Earlier evaluation · ${fmt(e.evaluatedAt)}`} />
                ))
              )}
            </>
          )}
        </div>
      )}
    </Panel>
  )
}
