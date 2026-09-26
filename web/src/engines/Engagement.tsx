import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useEngine, EnginePage } from '../components/shell/EnginePage'
import { Panel, Chip, Button, Unset } from '../components/ui/primitives'
import { EmptyState, LoadingState } from '../components/ui/states'
import { TimelinePulse } from '../components/motion/Signatures'
import { EvidenceButton } from '../components/ui/Evidence'
import type { EngagementEvent, Understanding } from '../lib/types'
import { prettyEvent } from '../lib/eventLabels'
import { RefreshCw } from 'lucide-react'

// Engagement (#983).
//
// The timeline is split the way the backend splits it: what the PROSPECT did
// above the axis, what ALTIUSNXT did below. Merging the two would let our own
// outreach read as their interest, which is the one mistake this engine was
// built to avoid — so the interface keeps the same separation.
//
// WHY THERE IS NO SUMMARY PANEL.
//
// This screen carried a Summary: events by the prospect, events by AltiusNXT,
// infrastructure events, distinct visits, last observed. On a real company it
// read "By AltiusNXT 733" beside "By the prospect 19", and neither number was
// defensible in front of a customer — nothing on the panel said what one unit
// of it was, which events were inside it, or over what period. A three-digit
// total next to a company name reads as interest whether or not anyone can
// say what a single unit of it means.
//
// The counts were not wrong; they were unapproved and easy to misread. So the
// screen now shows only what can be checked one act at a time: what happened,
// on which channel, when, and the reference behind it. Each of those is a
// fact with a source. The ENGINE is untouched — the summary endpoint, the
// event store and every API still exist and still work; this screen simply
// does not ask for the aggregate any more, because a value fetched in order
// not to show it can still leak through a loading or error state.

export function Engagement() {
  const engine = useEngine('engagement')
  const { company } = useCompany()
  const id = company?.crmCompanyId

  const timeline = useAsync<{ events: EngagementEvent[] }>(
    (signal) => api.get(`/engagement/companies/${id}/timeline?limit=100`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )

  // Intent Source, Engagement and Qualification, side by side — additive to
  // the timeline above, not a replacement for it. See lib/types.ts's
  // Understanding for exactly what this deliberately withholds (no raw score,
  // no threshold, no qualification reason).
  const understanding = useAsync<Understanding | null>(
    (signal) => (id ? api.get(`/engagement/companies/${id}/understanding`, { signal, nullOn404: true }) : Promise.resolve(null)),
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
  // lane, which reads them as something we did. They belong to neither party,
  // so they appear in neither lane.
  const prospectEvents = events.filter((e) => e.actor === 'prospect')
  const ourEvents = events.filter((e) => e.actor === 'altiusnxt')

  return (
    <EnginePage
      engineId="engagement"
      state={timeline.refreshing ? 'running' : events.length ? 'success' : 'idle'}
      signature={<TimelinePulse accent={engine.accent} />}
      actions={
        // A REFRESH, not a run. Engagement is what prospects did — opens,
        // clicks, replies, visits — so there is nothing here for us to execute.
        // A "Run engagement" button could only ever mean inventing an event,
        // which is exactly what this platform must never do.
        <Button icon={RefreshCw} onClick={() => timeline.refresh()} busy={timeline.refreshing}>
          Refresh timeline
        </Button>
      }
    >
      <UnderstandingPanel data={understanding.data} loading={understanding.loading} />

      {timeline.loading && !timeline.data ? (
        <LoadingState what="Reading the engagement history" visual={<TimelinePulse accent={engine.accent} />} />
      ) : events.length === 0 ? (
        <EmptyState
          title="No prospect engagement observed yet."
          detail="This engine records only what the server actually saw. Until this company opens something the platform published, there is nothing to show — and that absence is the honest answer rather than a zero."
        />
      ) : (
        <Panel title="Timeline" subtitle="Prospect actions above the line; AltiusNXT actions below it">
          <div className="tl">
            <div className="tl__lane tl__lane--prospect">
              <span className="tl__lanelabel">Prospect actions</span>
              <div className="tl__cards">
                {prospectEvents.slice(0, 24).map((e, i) => (
                  <EventCard key={e.id} event={e} index={i} accent={engine.accent} />
                ))}
                {prospectEvents.length === 0 && (
                  <p className="tl__none">No prospect engagement observed yet.</p>
                )}
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
      )}
    </EnginePage>
  )
}

/**
 * Intent Source, Engagement and Qualification, shown side by side — never
 * combined into one number, and never the raw score or threshold either. See
 * lib/types.ts's Understanding and the backend's engagement/understanding.ts
 * for exactly why each of those is withheld.
 */
function UnderstandingPanel({ data, loading }: { data: Understanding | null | undefined; loading: boolean }) {
  if (loading && !data) return null
  if (!data?.intentSource) return null

  const qualificationTone = (status: string): 'ok' | 'warn' | 'neutral' =>
    status === 'qualified' || status === 'qualified_unassigned' ? 'ok' : status === 'de_qualified' ? 'warn' : 'neutral'

  return (
    <Panel title="Understanding" subtitle="Intent Source, Engagement and Qualification — shown side by side, not combined">
      <div className="understanding">
        <section className="understanding__col">
          <p className="eyebrow">Intent source</p>
          {data.intentSource.count === 0 ? (
            <Unset what="No active intent signal" />
          ) : (
            <>
              <p className="understanding__count">{data.intentSource.count} active signal{data.intentSource.count === 1 ? '' : 's'}</p>
              <ul className="understanding__list">
                {data.intentSource.signals.map((s) => (
                  <li key={s.id} className="understanding__item">
                    <span>{s.summary}</span>
                    {s.sourceUrl && (
                      <EvidenceButton
                        title={s.signalType.replace(/_/g, ' ')}
                        label="Source"
                        items={[{ what: s.summary, source: s.sourceUrl, at: s.detectedAt, how: 'Detected by Intent Signals', reference: s.id }]}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>

        <section className="understanding__col">
          <p className="eyebrow">Engagement</p>
          {data.engagement ? (
            <Chip tone={data.engagement.level === 'HIGH' ? 'ok' : data.engagement.level === 'MEDIUM' ? 'warn' : 'neutral'}>
              {data.engagement.level}
            </Chip>
          ) : (
            <Unset what="Not yet calculated" />
          )}
        </section>

        <section className="understanding__col">
          <p className="eyebrow">Qualification</p>
          {data.qualification ? (
            <Chip tone={qualificationTone(data.qualification.status)}>{data.qualification.status.replace(/_/g, ' ')}</Chip>
          ) : (
            <Unset what="Not yet evaluated" />
          )}
        </section>
      </div>
      {data.disclaimers.map((d) => (
        <p key={d} className="note" style={{ marginTop: 'var(--s2)' }}>
          {d}
        </p>
      ))}
    </Panel>
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
          label="Reference"
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
