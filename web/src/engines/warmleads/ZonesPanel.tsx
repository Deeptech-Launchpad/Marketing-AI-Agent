import { MapPin } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { Button, Chip, Panel } from '../../components/ui/primitives'
import { DataTable } from '../../components/ui/DataTable'
import { num } from './labels'
import type { ZoneCount, ZonesView } from './types'

/**
 * The NXT Sales company list split into zones (regions, from each company's country). An admin chooses the zone to work
 * through; new evaluations then come only from it (earlier failures are still retried). Changing the zone never stops the
 * company being checked, and costs nothing by itself.
 */
export function ZonesPanel({
  admin,
  act,
  busy,
  refreshKey,
}: {
  admin: boolean
  act: (name: string, fn: () => Promise<unknown>) => Promise<void>
  busy: string | null
  refreshKey: number
}) {
  const zv = useAsync<ZonesView>((signal) => api.get('/warm-leads/zones', { signal }), [refreshKey])
  const active = zv.data?.activeZone ?? null
  const zones = Array.isArray(zv.data?.zones) ? zv.data!.zones : []
  const activeRow = zones.find((z) => z.zone === active) ?? null
  const choose = (zone: string | null) => act(`zone:${zone ?? 'all'}`, () => api.put('/warm-leads/zone', { zone }))

  return (
    <Panel
      title="Zones"
      subtitle="The company list split by country into regions. New companies are taken only from the chosen zone, a few each night; the zone is read from each company’s country in NXT Sales."
    >
      {zv.error && !zv.data && (
        <p className="note note--caveat" role="alert">
          The zones could not be read ({zv.error.message}).
        </p>
      )}
      {zv.data && (
        <>
          <p className="note" style={{ marginBottom: 'var(--s2)' }}>
            {active && activeRow ? (
              <>
                Working through <Chip tone="accent">{activeRow.label}</Chip> — {num(activeRow.pending)} of {num(activeRow.total)} still to check.
                {activeRow.pending === 0 && activeRow.total > 0 && <> This zone is done: choose the next one.</>}
              </>
            ) : (
              <>No zone chosen: new companies are taken from the whole list, in NXT Sales’ order.</>
            )}
          </p>
          <DataTable<ZoneCount>
            caption="Zones"
            rows={zones}
            rowKey={(z) => z.zone}
            columns={[
              { key: 'z', header: 'Zone', render: (z) => (z.zone === active ? <strong>{z.label}</strong> : z.label) },
              { key: 't', header: 'Companies', numeric: true, render: (z) => num(z.total) },
              { key: 'p', header: 'To check', numeric: true, render: (z) => num(z.pending) },
              { key: 'e', header: 'Checked', numeric: true, render: (z) => num(z.evaluated) },
              { key: 'w', header: 'Warm', numeric: true, render: (z) => num(z.warm) },
              { key: 's', header: 'Early signal', numeric: true, render: (z) => num(z.earlySignal) },
              { key: 'h', header: 'Needs review', numeric: true, render: (z) => num(z.humanReview) },
              { key: 'r', header: 'To retry', numeric: true, render: (z) => num(z.needsRetry) },
              ...(admin
                ? [
                    {
                      key: 'a',
                      header: '',
                      render: (z: ZoneCount) =>
                        z.zone === active ? (
                          <Chip tone="ok">Active</Chip>
                        ) : (
                          <Button icon={MapPin} variant="quiet" busy={busy === `zone:${z.zone}`} disabled={z.total === 0} onClick={() => choose(z.zone)}>
                            Work on this zone
                          </Button>
                        ),
                    },
                  ]
                : []),
            ]}
          />
          {admin && active && (
            <div style={{ marginTop: 'var(--s2)' }}>
              <Button variant="quiet" busy={busy === 'zone:all'} onClick={() => choose(null)}>
                Use the whole list (no zone)
              </Button>
            </div>
          )}
          <p className="note" style={{ marginTop: 'var(--s2)' }}>
            Zones are counted from the last read of the company list. “Unknown country” holds companies whose country is empty or not recognised in NXT Sales; correcting
            the country there moves the company on the next read. The pilot, when requested, is drawn from the chosen zone.
          </p>
        </>
      )}
    </Panel>
  )
}
