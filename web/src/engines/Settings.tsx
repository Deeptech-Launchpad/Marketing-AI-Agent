import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Cloud, KeyRound, LogOut, User } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useAuth } from '../lib/auth'
import { Panel, Chip, Button, Field, Unset } from '../components/ui/primitives'
import { AsyncBoundary, EmptyState } from '../components/ui/states'
import { OutreachSenderPanel } from './OutreachSenderPanel'
import { EmailSendingPanel } from './EmailSendingPanel'
import { TeamPanel } from './TeamPanel'
import './settings.css'

// SETTINGS — who is signed in, how to leave, and what the platform spent.
//
// The third block is the one with a way to go wrong. A usage dashboard is
// exactly the kind of screen that gets filled with plausible numbers because a
// chart with nothing in it looks broken, so this one is built the other way
// round: it starts from "unavailable", and only shows figures when the backend
// says it has real records to show. Every number it does show is counted from
// the platform's own request log, and the screen says so rather than implying
// it is reading Google's account.

interface UsageGroup {
  key: string
  calls: number
  totalTokens: number
  costUsd: number
}

interface GeminiUsage {
  provider: string
  configured: boolean
  available: boolean
  unavailableReason?: string
  scope: string
  scopeLabel: string
  scopeNote: string
  window: { from: string; to: string; days: number }
  totals?: {
    calls: number
    promptTokens: number
    outputTokens: number
    totalTokens: number
    costUsd: number
    pricedCalls: number
    unpricedCalls: number
    callsWithoutUsageData: number
    fellBack: number
    medianLatencyMs: number
  }
  byFeature?: UsageGroup[]
  byModel?: UsageGroup[]
  daily?: Array<{ date: string; calls: number; totalTokens: number }>
  caveats?: string[]
  note: string
}

const WINDOWS = [7, 30, 90] as const

const num = (n: number): string => n.toLocaleString()

/** The signed-in person's initials, since the platform stores no avatar. */
function Avatar({ name, email }: { name: string | null; email: string }) {
  const source = (name ?? email).trim()
  const initials = source
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
  return (
    <span className="set__avatar" aria-hidden="true">
      {initials || '?'}
    </span>
  )
}

export function Settings() {
  const { principal, signOut, can } = useAuth()
  const navigate = useNavigate()
  const [days, setDays] = useState<number>(30)

  const usage = useAsync<GeminiUsage>(
    (signal) => api.get<GeminiUsage>(`/usage/gemini?days=${days}`, { signal }),
    [days],
  )

  return (
    <div className="set">
      <header className="set__head">
        <h1 className="set__title">Settings</h1>
        <p className="set__sub">Your account, and what this platform has spent against its configured API keys.</p>
      </header>

      <Panel title="Profile" subtitle="Read from the NXT Sales account you signed in with">
        {principal ? (
          <div className="set__profile">
            <Avatar name={principal.name} email={principal.email} />
            <div className="set__profilebody">
              <p className="set__name">{principal.name ?? principal.email}</p>
              <p className="set__email">{principal.email}</p>
              <div className="row">
                <Chip tone="ok">{principal.role}</Chip>
                {/* The role is often also one of the permissions it grants;
                    printing it twice reads as two different facts. */}
                {principal.permissions
                  .filter((perm) => perm !== principal.role)
                  .map((perm) => (
                    <Chip key={perm}>{perm}</Chip>
                  ))}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="Not signed in" detail="No account is attached to this session." />
        )}

        {/* No avatar upload: the platform stores no image for a user, and an
            upload control that silently discards the file would be worse than
            not offering one. The initials come from the account itself. */}
        <p className="note" style={{ marginTop: 'var(--s4)' }}>
          <User size={12} aria-hidden="true" /> Your name, email and role come from your NXT Sales account. Change them
          there and they change here; this platform keeps no separate copy and stores no profile picture.
        </p>
      </Panel>

      {/* CRM Sync lives here rather than on the engine rail: it is a handoff
          to another system, not a stage a company moves through. */}
      <Panel title="CRM Sync" subtitle="The handoff from this platform to NXT Sales">
        <p className="note">
          Prepares a verified handoff package for a company and shows whether it can be delivered to NXT Sales. It sits
          here, apart from the engines, because it is a connection to another system rather than a pipeline stage.
        </p>
        <div className="row" style={{ marginTop: 'var(--s4)' }}>
          <Button icon={Cloud} onClick={() => navigate('/settings/crm-sync')}>
            Open CRM Sync
          </Button>
        </div>
      </Panel>

      {can('admin') && <TeamPanel />}
      <OutreachSenderPanel />
      <EmailSendingPanel />

      <Panel title="Session">
        <p className="note">Signing out clears this browser&rsquo;s token. It does not sign you out of NXT Sales.</p>
        <div className="row" style={{ marginTop: 'var(--s4)' }}>
          <Button icon={LogOut} variant="primary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </Panel>

      <Panel
        title="Gemini API usage"
        subtitle="Marketing AI project usage"
        actions={
          <div className="set__windows" role="group" aria-label="Usage window">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className="set__window"
                aria-pressed={days === w}
                onClick={() => setDays(w)}
              >
                {w}d
              </button>
            ))}
          </div>
        }
      >
        <AsyncBoundary state={usage} what="Reading the Gemini request log">
          {(data) =>
            !data.available ? (
              // The required behaviour when there is nothing real to show. It
              // names the DEPENDENCY rather than drawing an empty chart.
              <div className="set__unavail">
                <KeyRound size={16} aria-hidden="true" />
                <div>
                  <p className="set__unavailtitle">Usage data unavailable</p>
                  <p className="set__unavailwhy">{data.unavailableReason}</p>
                  <p className="note" style={{ marginTop: 'var(--s3)' }}>
                    {data.configured
                      ? 'The key is configured; there is simply nothing recorded in this window.'
                      : 'Set GEMINI_API_KEY and LLM_DRIVER=real for this environment, and usage will appear here as it is spent.'}
                  </p>
                </div>
              </div>
            ) : (
              <>
                <dl className="set__stats">
                  <div>
                    <dt>Requests</dt>
                    <dd className="tnum">{num(data.totals!.calls)}</dd>
                  </div>
                  <div>
                    <dt>Prompt tokens</dt>
                    <dd className="tnum">{num(data.totals!.promptTokens)}</dd>
                  </div>
                  <div>
                    <dt>Output tokens</dt>
                    <dd className="tnum">{num(data.totals!.outputTokens)}</dd>
                  </div>
                  <div>
                    <dt>Total tokens</dt>
                    <dd className="tnum">{num(data.totals!.totalTokens)}</dd>
                  </div>
                  <div>
                    <dt>Recorded cost</dt>
                    <dd className="tnum">
                      {data.totals!.pricedCalls > 0 ? (
                        `$${data.totals!.costUsd.toFixed(4)}`
                      ) : (
                        <Unset what="No pricing recorded" />
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Median latency</dt>
                    <dd className="tnum">{num(data.totals!.medianLatencyMs)} ms</dd>
                  </div>
                </dl>

                {data.caveats && data.caveats.length > 0 && (
                  <ul className="set__caveats">
                    {data.caveats.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                )}

                {data.byFeature && data.byFeature.length > 0 && (
                  <>
                    <p className="eyebrow" style={{ marginTop: 'var(--s5)' }}>
                      By feature
                    </p>
                    <ul className="set__bars">
                      {data.byFeature.slice(0, 8).map((g) => {
                        const max = data.byFeature![0]!.totalTokens || 1
                        return (
                          <li key={g.key}>
                            <span className="set__barlabel">{g.key.replace(/_/g, ' ')}</span>
                            <span className="set__bartrack">
                              <span
                                className="set__barfill"
                                style={{ width: `${Math.round((g.totalTokens / max) * 100)}%` }}
                              />
                            </span>
                            <span className="set__barval tnum">
                              {num(g.totalTokens)} tok · {num(g.calls)} req
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  </>
                )}

                {data.byModel && data.byModel.length > 0 && (
                  <>
                    <p className="eyebrow" style={{ marginTop: 'var(--s5)' }}>
                      By model
                    </p>
                    {data.byModel.slice(0, 6).map((g) => (
                      <Field
                        key={g.key}
                        label={g.key}
                        value={`${num(g.totalTokens)} tokens over ${num(g.calls)} request(s)`}
                      />
                    ))}
                  </>
                )}

                {/* The promise first, the mechanism under it. A reader who
                    only takes in one line must take in the right one. */}
                <p className="set__scope" style={{ marginTop: 'var(--s5)' }}>
                  {data.note}
                </p>
                <p className="note">{data.scopeNote}</p>
              </>
            )
          }
        </AsyncBoundary>
      </Panel>
    </div>
  )
}
