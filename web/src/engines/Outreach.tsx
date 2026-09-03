import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Chip, StatusBadge, toUiStatus, Unset, Metric, MetricRow } from '../components/ui/primitives'
import { BlockedState, LoadingState } from '../components/ui/states'
import { SequencePath } from '../components/motion/Signatures'
import type { ChannelStatus } from '../lib/types'
import { Mail, MessageSquare, Phone, Send, Clock } from 'lucide-react'

// Multichannel Outreach (#982).
//
// The engine composes, validates and schedules; a person releases every send.
// The interface reflects that: a drafted or blocked action is never presented
// as sent, and each channel reports its own provider availability in the
// provider's own words.

const CHANNEL_ICON: Record<string, typeof Mail> = {
  email: Mail,
  email_followup: Mail,
  linkedin: MessageSquare,
  call: Phone,
  whatsapp: MessageSquare,
}

export function Outreach() {
  const engine = useEngine('outreach')

  const channels = useAsync<{ channels: ChannelStatus[] } | ChannelStatus[]>(
    (signal) => api.get('/outreach/channels', { signal }),
    [],
  )

  const rows: ChannelStatus[] = Array.isArray(channels.data)
    ? channels.data
    : (channels.data?.channels ?? [])

  const available = rows.filter((c) => c.status === 'available')
  const blocked = rows.filter((c) => c.status !== 'available')

  return (
    <EnginePage
      engineId="outreach"
      state={available.length ? 'idle' : 'idle'}
      signature={<SequencePath accent={engine.accent} />}
    >
      {channels.loading && !channels.data ? (
        <LoadingState what="Checking which channels can actually send" visual={<SequencePath accent={engine.accent} />} />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel title="Sequence" subtitle="The default cadence, and what each channel can do today">
                <div className="viz viz--short">
                  <SequencePath accent={engine.accent} label="Outreach sequence" />
                </div>

                <div className="seq">
                  {rows.map((c, i) => {
                    const Icon = CHANNEL_ICON[c.channel] ?? Send
                    const ok = c.status === 'available'
                    return (
                      <div
                        key={c.channel}
                        className={`seq__step node-reveal${ok ? '' : ' is-blocked'}`}
                        style={{ ['--i' as string]: i, ['--e' as string]: engine.accent }}
                      >
                        <span className="seq__icon">
                          <Icon size={15} aria-hidden="true" />
                        </span>
                        <span className="seq__name">{c.channel.replace(/_/g, ' ')}</span>
                        <StatusBadge status={toUiStatus(c.status)} label={c.status.replace(/_/g, ' ')} size="sm" />
                      </div>
                    )
                  })}
                </div>
              </Panel>

              {/* Each unavailable channel states its own blocker, quoted from
                  the provider rather than summarised. */}
              {blocked.map((c) => (
                <BlockedState
                  key={c.channel}
                  what={`${c.channel.replace(/_/g, ' ')} cannot send`}
                  why={c.reason ?? 'This channel has no configured provider.'}
                  affects={`Any sequence step on the ${c.channel.replace(/_/g, ' ')} channel is prepared but never dispatched.`}
                  remediation={c.remediation ?? 'Configure a provider for this channel.'}
                />
              ))}
            </>
          }
          side={
            <>
              <Panel title="Channels">
                <MetricRow>
                  <Metric label="Available" value={available.length} accent size="sm" />
                  <Metric label="Blocked" value={blocked.length} size="sm" />
                </MetricRow>
                <div className="stack" style={{ marginTop: 'var(--s4)' }}>
                  {rows.map((c) => (
                    <div key={c.channel} className="prov">
                      <div className="prov__head">
                        <span className="prov__name">{c.channel.replace(/_/g, ' ')}</span>
                        <Chip tone={c.status === 'available' ? 'ok' : 'warn'}>{c.status.replace(/_/g, ' ')}</Chip>
                      </div>
                      <p className="prov__dest">via {c.provider}</p>
                    </div>
                  ))}
                  {rows.length === 0 && <Unset what="No channel reported" />}
                </div>
              </Panel>

              <Panel title="Send posture">
                <p className="note">
                  The platform composes, validates and schedules. It does not send on its own — every external action
                  waits for a person to release it, and a campaign runs as a rehearsal by default.
                </p>
                <div className="row" style={{ marginTop: 'var(--s3)' }}>
                  <Chip tone="warn">
                    <Clock size={11} aria-hidden="true" /> Dry run by default
                  </Chip>
                </div>
              </Panel>
            </>
          }
        />
      )}
    </EnginePage>
  )
}
