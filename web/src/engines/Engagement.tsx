import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, Unset } from '../components/ui/primitives'
import { EmptyState, LoadingState } from '../components/ui/states'
import { TimelinePulse } from '../components/motion/Signatures'
import { EvidenceButton } from '../components/ui/Evidence'
import type { EngagementEvent, EngagementSummary } from '../lib/types'
import { prettyEvent } from './IntentScoring'

// Engagement (#983).
//
// The timeline is split the way the backend splits it: what the PROSPECT did
// above the axis, what ALTIUSNXT did below. Merging the two would let our own
// outreach read as their interest, which is the one mistake this engine was
// built to avoid — so the interface keeps the same separation.

export function Engagement() {
  const engine = useEngine('engagement')
  const { company } = useCompany()
  const id = company?.crmCompanyId

  const summary = useAsync<EngagementSummary | null>(
    (signal) => (id ? api.get(`/engagement/companies/${id}/summary`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )
  const timeline = useAsync<{ events: EngagementEvent[] }>(
    (signal) => api.get(`/engagement/companies/${id}/timeline?limit=100`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )

  if (!company) {
    return (
      <EnginePage engineId="engagement">
        <EmptyState title="Select a company" detail="Engagement is recorded per company." />
      </EnginePage>
    )
  }

  const events = timeline.data?.events ?? []
  // Both lanes match their actor EXACTLY. The previous "not prospect" test put
  // infrastructure events — a bounce, a delivery receipt — in the AltiusNXT
  // lane, which reads them as something we did. They belong to neither party
  // and are counted separately in the summary as Infrastructure.
  const prospectEvents = events.filter((e) => e.actor === 'prospect')
  const ourEvents = events.filter((e) => e.actor === 'altiusnxt')

  return (
    <EnginePage
      engineId="engagement"
      state={events.length ? 'success' : 'idle'}
      signature={<TimelinePulse accent={engine.accent} />}
    >
      {timeline.loading && !timeline.data ? (
        <LoadingState what="Reading the engagement history" visual={<TimelinePulse accent={engine.accent} />} />
      ) : events.length === 0 ? (
        <EmptyState
          title="Nothing observed yet"
          detail="This engine records only what the server actually saw. Until this company opens something the platform published, there is nothing to show — and that absence is the honest answer rather than a zero."
        />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel title="Timeline" subtitle="Prospect actions above the line; AltiusNXT actions below it">
                <div className="tl">
                  <div className="tl__lane tl__lane--prospect">
                    <span className="tl__lanelabel">Prospect actions</span>
                    <div className="tl__cards">
                      {prospectEvents.slice(0, 24).map((e, i) => (
                        <EventCard key={e.id} event={e} index={i} accent={engine.accent} />
                      ))}
                      {prospectEvents.length === 0 && <p className="tl__none">No prospect action observed.</p>}
                    </div>
                  </div>

                  <div className="tl__axis" aria-hidden="true">
                    <TimelinePulse accent={engine.accent} />
                  </div>

                  <div className="tl__lane tl__lane--ours">
                    <span className="tl__lanelabel">AltiusNXT actions</span>
                    <div className="tl__cards">
                      {ourEvents.slice(0, 24).map((e, i) => (
                        <EventCard key={e.id} event={e} index={i} accent="var(--text-muted)" ours />
                      ))}
                      {ourEvents.length === 0 && <p className="tl__none">No AltiusNXT action recorded.</p>}
                    </div>
                  </div>
                </div>
              </Panel>
            </>
          }
          side={
            <>
              <Panel title="Summary">
                {summary.data ? (
                  <>
                    <MetricRow>
                      <Metric label="By the prospect" value={summary.data.prospectEvents} accent size="sm" />
                      <Metric label="By AltiusNXT" value={summary.data.ourEvents} size="sm" />
                      <Metric label="Infrastructure" value={summary.data.systemEvents} size="sm" />
                    </MetricRow>
                    <div className="stack" style={{ marginTop: 'var(--s4)' }}>
                      <Metric label="Distinct visits" value={summary.data.distinctSessions} size="sm" />
                      <Metric
                        label="Last observed"
                        value={
                          summary.data.lastEventAt ? new Date(summary.data.lastEventAt).toLocaleString() : '—'
                        }
                        hint={summary.data.lastEventAgeHours !== null ? `${summary.data.lastEventFreshness} · ${summary.data.lastEventAgeHours}h ago` : undefined}
                        size="sm"
                      />
                    </div>
                    <p className="note" style={{ marginTop: 'var(--s4)' }}>
                      {summary.data.note}
                    </p>
                  </>
                ) : (
                  <Unset />
                )}
              </Panel>

              <Panel title="Channels">
                {summary.data ? (
                  <>
                    <p className="note">Observed</p>
                    <div className="row">
                      {summary.data.channelsObserved.map((c) => (
                        <Chip key={c} tone="accent">
                          {c.replace(/_/g, ' ')}
                        </Chip>
                      ))}
                      {summary.data.channelsObserved.length === 0 && <Unset what="None" />}
                    </div>
                    {/* Absence stated positively, as #983 records it. */}
                    <p className="note" style={{ marginTop: 'var(--s4)' }}>
                      Not observed
                    </p>
                    <div className="row">
                      {summary.data.channelsNotObserved.map((c) => (
                        <Chip key={c}>{c.replace(/_/g, ' ')}</Chip>
                      ))}
                      {summary.data.channelsNotObserved.length === 0 && <Unset what="None" />}
                    </div>
                  </>
                ) : (
                  <Unset />
                )}
              </Panel>
            </>
          }
        />
      )}
    </EnginePage>
  )
}

function EventCard({
  event,
  index,
  accent,
  ours,
}: {
  event: EngagementEvent
  index: number
  accent: string
  ours?: boolean
}) {
  return (
    <article
      className={`tl__card node-reveal${ours ? ' tl__card--ours' : ''}`}
      style={{ ['--i' as string]: Math.min(index, 14), ['--e' as string]: accent }}
    >
      <header className="tl__cardhead">
        <span className="tl__time mono">{new Date(event.occurredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        <Chip>{event.channel.replace(/_/g, ' ')}</Chip>
      </header>
      <p className="tl__what">{prettyEvent(event.eventType)}</p>
      <p className="tl__how">{event.evidence.what}</p>
      <footer className="tl__cardfoot">
        <span className="tl__fresh mono">{event.freshnessLabel}</span>
        <EvidenceButton
          title={prettyEvent(event.eventType)}
          label="Evidence"
          items={[
            {
              what: event.evidence.what,
              source: event.evidence.where ?? event.source,
              at: event.occurredAt,
              how: event.evidence.how,
              reference: event.evidence.referenceId ?? event.id,
            },
          ]}
        />
      </footer>
    </article>
  )
}
