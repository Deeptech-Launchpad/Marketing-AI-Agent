import { useState } from 'react'
import { ArrowLeft, Download } from 'lucide-react'
import { api, getToken } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { Button, Chip, Panel } from '../../components/ui/primitives'
import { EmptyState, ErrorState, LoadingState } from '../../components/ui/states'

// THE COMPANIES A BULK SEND SKIPPED (2026-10-21) — a read-only view of the
// recipients that were not emailed, each with the reason, and the same list as
// an Excel file. `id` is a bulk send's id, or 'latest' for the most recent send
// made from an Excel list. Nothing here sends, changes or retries an email.

interface SkippedRow {
  no: number
  companyName: string
  contactName: string | null
  toEmail: string | null
  ccEmails: string[]
  sourceRows: number[]
  status: string
  reason: string
  detail: string | null
  skippedLocal: string
}
interface SkippedReport {
  campaign: { id: string; name: string; sourceFileName: string | null; startLocal: string; status: string }
  counts: { total: number; sent: number; failed: number; skipped: number }
  rows: SkippedRow[]
}

/** Downloads the Excel file. It needs the sign-in token, so it cannot be a plain link. */
async function downloadSkippedXlsx(id: string): Promise<void> {
  const token = getToken()
  const res = await fetch(`/api/v1/outreach/bulk/${encodeURIComponent(id)}/skipped.xlsx`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  if (!res.ok) throw new Error(`The Excel file could not be created (HTTP ${res.status}).`)
  const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'skipped-companies.xlsx'
  const url = URL.createObjectURL(await res.blob())
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    URL.revokeObjectURL(url)
  }
}

export function SkippedCompanies({ id, onBack }: { id: string; onBack: () => void }) {
  const state = useAsync<unknown>((signal) => api.get(`/outreach/bulk/${encodeURIComponent(id)}/skipped`, { signal }), [id])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const report = state.data as SkippedReport | null

  if (state.loading && !report) return <LoadingState what="Reading the skipped companies" />
  if (state.error && !report) return <ErrorState error={state.error} what="The skipped companies could not be read" onRetry={state.refresh} />
  if (!report?.campaign) return <ErrorState error={new Error('The report was not in the response.')} what="The skipped companies could not be read" onRetry={state.refresh} />

  const { campaign: c, counts, rows } = report
  const download = async () => {
    setBusy(true)
    setError(null)
    try {
      await downloadSkippedXlsx(c.id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      title="Skipped companies"
      subtitle={`${c.name} · started ${c.startLocal}${c.sourceFileName ? ` · ${c.sourceFileName}` : ''}`}
      actions={
        <div className="row">
          <Button size="sm" variant="quiet" icon={ArrowLeft} onClick={onBack}>
            All bulk emails
          </Button>
          <Button size="sm" variant="primary" icon={Download} busy={busy} disabled={rows.length === 0} onClick={() => void download()}>
            Download Excel
          </Button>
        </div>
      }
    >
      <p>
        <strong>{counts.skipped}</strong> skipped · {counts.sent} sent · {counts.failed} failed — of {counts.total}
      </p>
      {error && (
        <p className="otr-err" role="alert">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState title="No skipped companies" detail="Every email in this bulk send was sent or is still scheduled." />
      ) : (
        <div className="otr-scroll">
          <table className="otr-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Recipient email</th>
                <th>Reason skipped</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.no}-${r.companyName}`}>
                  <td>
                    {r.companyName}
                    <div className="cell-dim">
                      {r.contactName ?? ''}
                      {r.sourceRows.length > 0 ? `${r.contactName ? ' · ' : ''}sheet row ${r.sourceRows.join(', ')}` : ''}
                    </div>
                  </td>
                  <td className="cell-dim">
                    {r.toEmail ?? '—'}
                    {r.ccEmails.length > 0 && <div>CC: {r.ccEmails.join(', ')}</div>}
                  </td>
                  <td>{r.reason}</td>
                  <td>
                    <Chip tone="neutral">Skipped</Chip>
                    {r.detail && <div className="cell-dim">{r.detail}</div>}
                    <div className="cell-dim">{r.skippedLocal}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  )
}
