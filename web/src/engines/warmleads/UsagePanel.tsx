import { Chip, Metric, MetricRow, Panel } from '../../components/ui/primitives'
import { DataTable } from '../../components/ui/DataTable'
import { bucketLabel, num, STOPPED } from './labels'
import type { Overview, Usage } from './types'

/** Daily use of the limits, and what it cost where the provider reported a price. */
export function UsagePanel({ o }: { o: Overview }) {
  const t = o.today
  return (
    <Panel
      title="Usage"
      subtitle={`${bucketLabel(o.bucket)} — each night’s companies and Gemini calls are counted in the database, so the limits hold across restarts.`}
    >
      {t ? (
        <>
          <MetricRow>
            <Metric label="Companies" value={`${num(t.companiesStarted)}/${num(t.companyLimit)}`} hint="started" />
            <Metric label="Gemini calls" value={`${num(t.geminiCalls)}/${num(t.geminiCeiling)}`} hint="ceiling" />
            <Metric label="Screened" value={num(t.screened)} hint="CRM + website" />
            <Metric label="Web research" value={num(t.deepResearched)} hint="Gemini" />
            <Metric label="Completed" value={num(t.completed)} />
            <Metric label="Research incomplete" value={num(t.incomplete)} hint="not Cold" />
            <Metric label="Failed" value={num(t.failed)} />
            <Metric label="Cost (priced)" value={`$${t.pricedCostUsd.toFixed(4)}`} hint={t.unpricedCalls ? `${t.unpricedCalls} calls without a price` : 'all priced'} />
          </MetricRow>
          {t.stoppedReason && (
            <p className="note" style={{ marginTop: 'var(--s2)' }}>
              Last stop: {STOPPED[t.stoppedReason] ?? t.stoppedReason}.
            </p>
          )}
        </>
      ) : (
        <p className="note">Nothing has been processed in this period yet.</p>
      )}

      {o.usage.length > 0 && (
        <div style={{ marginTop: 'var(--s4)' }}>
          <DataTable<Usage>
            caption="Recent usage"
            rows={o.usage}
            rowKey={(u) => u.bucket}
            columns={[
              { key: 'b', header: 'Period', render: (u) => bucketLabel(u.bucket) },
              { key: 'c', header: 'Companies', numeric: true, render: (u) => `${u.companiesStarted}/${u.companyLimit}` },
              { key: 'g', header: 'Gemini calls', numeric: true, render: (u) => `${u.geminiCalls}/${u.geminiCeiling}` },
              { key: 'd', header: 'Web research', numeric: true, render: (u) => u.deepResearched },
              { key: 'i', header: 'Incomplete', numeric: true, render: (u) => u.incomplete },
              { key: 'f', header: 'Failed', numeric: true, render: (u) => u.failed },
              { key: 'cost', header: 'Cost (priced)', numeric: true, render: (u) => `$${u.pricedCostUsd.toFixed(4)}` },
              { key: 's', header: 'Stopped because', render: (u) => (u.stoppedReason ? <Chip>{STOPPED[u.stoppedReason] ?? u.stoppedReason}</Chip> : '—') },
            ]}
          />
          <p className="note" style={{ marginTop: 'var(--s2)' }}>
            Cost counts only Gemini calls whose model has a published price; other calls are counted as “without a price” and never estimated.
          </p>
        </div>
      )}
    </Panel>
  )
}
