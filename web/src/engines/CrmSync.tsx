import { useState } from 'react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useAuth } from '../lib/auth'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Chip, Button, Field, Unset, StatusBadge, toUiStatus } from '../components/ui/primitives'
import { BlockedState, EmptyState, ErrorState, LoadingState } from '../components/ui/states'
import { SyncFlow } from '../components/motion/Signatures'
import { Drawer } from '../components/ui/Evidence'
import { DataTable } from '../components/ui/DataTable'
import type { CrmSyncProviders, CrmSyncRecord, Qualification } from '../lib/types'
import { Play, FileJson } from 'lucide-react'

// CRM / NXT Sales (#986).
//
// The blocked state is the important one on this installation, and it must
// never look like a success. The flow animation stalls its packets at the
// boundary rather than delivering them, the label says "prepared", and the
// exact blocker is quoted from the provider.

/** Why a handoff is held, said in the terms of the state that held it. */
const BLOCKED_WHY: Record<string, string> = {
  blocked_not_qualified:
    'This lead has not qualified, so nothing is handed to the CRM. Only a qualified lead enters the handoff.',
  blocked_validation:
    'The package did not validate, so it was not offered to the CRM. The failed checks are listed under Validation.',
  blocked_missing_owner: 'The package is prepared but no sales owner is assigned, so there is nobody to hand it to.',
  blocked_provider_unavailable:
    'The package is prepared but cannot be synchronised because no approved CRM write adapter is configured.',
  default: 'The package is prepared and held rather than delivered.',
}

/** What would actually clear it. */
const BLOCKED_FIX: Record<string, string> = {
  blocked_not_qualified: 'Nothing to do here. A handoff is prepared automatically if and when this lead qualifies.',
  blocked_validation: 'Resolve the failed checks below, then prepare the handoff again.',
  blocked_missing_owner: 'Assign an account owner on the company record in NXT Sales.',
  default: 'Approve a CRM write adapter and add the write methods to the CRM port.',
}

export function CrmSync() {
  const engine = useEngine('crm')
  const { company } = useCompany()
  const { can } = useAuth()
  const [busy, setBusy] = useState(false)
  const [prepareError, setPrepareError] = useState<Error | null>(null)
  const [payloadOpen, setPayloadOpen] = useState(false)
  const id = company?.crmCompanyId

  const qual = useAsync<Qualification | null>(
    (signal) => (id ? api.get(`/sales-qualification/companies/${id}`, { signal, nullOn404: true }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )
  const sync = useAsync<CrmSyncRecord | null>(
    (signal) =>
      qual.data?.id ? api.get(`/crm-sync/qualifications/${qual.data.id}`, { signal, nullOn404: true }) : Promise.resolve(null),
    [qual.data?.id],
    { enabled: Boolean(qual.data?.id) },
  )
  const providers = useAsync<CrmSyncProviders>((signal) => api.get('/crm-sync/providers', { signal }), [])
  const payload = useAsync<{ payload: unknown; mappingVersion: string; note: string }>(
    (signal) => api.get(`/crm-sync/${sync.data?.syncId}/payload`, { signal, nullOn404: true }),
    [sync.data?.syncId, payloadOpen],
    { enabled: Boolean(sync.data?.syncId) && payloadOpen },
  )

  const prepare = async () => {
    if (!qual.data?.id) return
    setBusy(true)
    setPrepareError(null)
    try {
      await api.post(`/crm-sync/qualifications/${qual.data.id}`, {})
      sync.refresh()
    } catch (err) {
      // It had no catch: a refused or failed prepare just stopped spinning and
      // said nothing (2026-10-06).
      setPrepareError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setBusy(false)
    }
  }

  if (!company) {
    return (
      <EnginePage engineId="crm">
        <EmptyState title="Select a company" detail="A CRM handoff is prepared per qualified lead." />
      </EnginePage>
    )
  }

  const blocked = sync.data?.state?.startsWith('blocked') ?? false
  const synced = sync.data?.state === 'synced'

  return (
    <EnginePage
      engineId="crm"
      state={busy ? 'running' : synced ? 'success' : blocked ? 'idle' : 'idle'}
      signature={<SyncFlow accent={engine.accent} blocked={blocked} />}
      actions={
        can('operate') &&
        qual.data?.id && (
          <Button icon={Play} onClick={prepare} busy={busy}>
            Prepare handoff
          </Button>
        )
      }
    >
      {prepareError && (
        <p className="note note--caveat" role="alert">
          The handoff could not be prepared: {prepareError.message}
        </p>
      )}
      {qual.loading ? (
        <LoadingState what="Checking whether this lead has qualified" visual={<SyncFlow accent={engine.accent} />} />
      ) : qual.error ? (
        // A failed read is not "no qualified lead" (2026-10-06).
        <ErrorState error={qual.error} what="Whether this lead has qualified could not be read" onRetry={qual.refresh} />
      ) : !qual.data?.id ? (
        <EmptyState
          title="No qualified lead to hand over"
          // There is no Sales Qualification screen to send anyone to:
          // qualification runs by itself in the background (2026-10-06).
          detail="Only a qualified lead enters the CRM flow. Qualification runs automatically in the background as a company's evidence builds up — the platform never pushes unqualified prospects into the CRM."
        />
      ) : sync.loading && !sync.data ? (
        <LoadingState what="Reading the handoff state" visual={<SyncFlow accent={engine.accent} blocked />} />
      ) : sync.error && !sync.data ? (
        <ErrorState error={sync.error} what="The handoff state could not be read" onRetry={sync.refresh} />
      ) : !sync.data?.prepared ? (
        <EmptyState
          title="No handoff prepared yet"
          detail="Prepare a package to validate this lead's evidence and stage it for the CRM."
          action={can('operate') ? <Button variant="primary" icon={Play} onClick={prepare} busy={busy}>Prepare handoff</Button> : undefined}
        />
      ) : (
        <EngineSplit
          main={
            <>
              {/* The flow: platform → sync layer → CRM. Packets stall at the
                  boundary while the adapter is unavailable. */}
              <Panel title="Handoff" subtitle={`${sync.data.mappingVersion} · ${sync.data.payloadVersion}`}>
                <div className="sync">
                  <div className="sync__end">
                    <span className="sync__endlabel">Marketing AI</span>
                    <span className="sync__endsub">{company.companyName}</span>
                  </div>

                  <div className="sync__pipe">
                    <SyncFlow accent={engine.accent} blocked={blocked} />
                    <span className={`sync__verdict${blocked ? ' is-blocked' : synced ? ' is-ok' : ''}`}>
                      {sync.data.stateLabel}
                    </span>
                  </div>

                  <div className={`sync__end sync__end--target${blocked ? ' is-blocked' : ''}`}>
                    <span className="sync__endlabel">NXT Sales</span>
                    <span className="sync__endsub">{sync.data.provider.status.replace(/_/g, ' ')}</span>
                  </div>
                </div>
              </Panel>

              {/* Per-resource results — never averaged into one word. */}
              <Panel title="Resources" subtitle="Each CRM object reports its own outcome" padded={false}>
                <DataTable
                  rows={sync.data.resources}
                  rowKey={(r) => r.resource}
                  columns={[
                    { key: 'resource', header: 'Object', render: (r) => <span className="cell-strong">{r.resource}</span> },
                    { key: 'result', header: 'Result', render: (r) => <StatusBadge status={toUiStatus(r.result)} label={r.result.replace(/_/g, ' ')} size="sm" /> },
                    { key: 'why', header: 'Why', render: (r) => <span className="cell-dim">{r.reason ?? '—'}</span> },
                  ]}
                />
              </Panel>

              {blocked && (
                <BlockedState
                  // The state says WHY, and they are not the same why: a lead
                  // that has not qualified is not a missing adapter, and
                  // naming the wrong blocker sends someone to fix the wrong
                  // thing. The label comes from the record itself.
                  what={sync.data.stateLabel}
                  why={sync.data.lastError?.message ?? BLOCKED_WHY[sync.data.state] ?? BLOCKED_WHY.default!}
                  affects={
                    // Validation and a missing owner are about THIS lead's own
                    // record, not every lead (2026-10-06).
                    sync.data.state === 'blocked_not_qualified' ||
                    sync.data.state === 'blocked_validation' ||
                    sync.data.state === 'blocked_missing_owner'
                      ? 'This lead only. Other leads are unaffected.'
                      : 'Every qualified lead. Packages are validated and held in the outbox rather than delivered.'
                  }
                  remediation={
                    sync.data.state === 'blocked_provider_unavailable'
                      ? (providers.data?.providers?.find((p) => p.name === 'nxt_sales')?.remediation ??
                        'Approve a CRM write adapter and add the write methods to the CRM port.')
                      : (BLOCKED_FIX[sync.data.state] ?? BLOCKED_FIX.default!)
                  }
                  action={
                    <Button icon={FileJson} onClick={() => setPayloadOpen(true)}>
                      Inspect prepared package
                    </Button>
                  }
                />
              )}

              {/* Validation is shown whether or not it passed — a package that
                  validated cleanly is itself worth stating. */}
              <Panel title="Validation">
                <div className="row" style={{ marginBottom: 'var(--s3)' }}>
                  <StatusBadge
                    status={sync.data.validation.ok ? 'complete' : 'error'}
                    label={sync.data.validation.ok ? 'Package validated' : 'Validation failed'}
                  />
                </div>
                {sync.data.validation.issues.length === 0 ? (
                  <p className="note">Every check passed. The package is internally consistent and its evidence resolves.</p>
                ) : (
                  <ul className="issues">
                    {sync.data.validation.issues.map((iss, i) => (
                      <li key={i} className={`issues__item is-${iss.severity}`}>
                        <span className="issues__check mono">{iss.check}</span>
                        <span>{iss.message}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </>
          }
          side={
            <>
              <Panel title="Handoff record">
                <Field label="State" value={sync.data.stateLabel} />
                <Field label="Provider" value={sync.data.provider.name} />
                <Field label="Attempts" value={sync.data.attempts} />
                <Field label="Owner" value={sync.data.owner.status} />
                <Field
                  label="Last attempt"
                  value={sync.data.lastAttemptAt ? new Date(sync.data.lastAttemptAt).toLocaleString() : <Unset />}
                />
                <Field label="Correlation key" value={sync.data.externalKey} mono />
              </Panel>

              {sync.data.outbox && (
                <Panel title="Outbox" subtitle="Prepared packages awaiting an adapter">
                  <Field label="State" value={sync.data.outbox.state} />
                  <Field label="Held since" value={new Date(sync.data.outbox.createdAt).toLocaleString()} />
                  <Field label="Refreshed" value={`${sync.data.outbox.attemptCount} time(s)`} />
                  <p className="note" style={{ marginTop: 'var(--s3)' }}>{sync.data.outbox.reason}</p>
                  <div style={{ marginTop: 'var(--s3)' }}>
                    <Button icon={FileJson} onClick={() => setPayloadOpen(true)}>
                      View package
                    </Button>
                  </div>
                </Panel>
              )}

              <Panel title="Providers">
                {providers.data?.providers ? (
                  <div className="stack">
                    {providers.data.providers.map((p) => (
                      <div key={p.name} className="prov">
                        <div className="prov__head">
                          <span className="prov__name">{p.name.replace(/_/g, ' ')}</span>
                          <Chip tone={p.status === 'available' ? 'ok' : 'warn'}>{p.status.replace(/_/g, ' ')}</Chip>
                        </div>
                        <p className="prov__dest">{p.destination}</p>
                        <div className="row">
                          <Chip tone={p.capabilities.canCreate ? 'ok' : 'neutral'}>create</Chip>
                          <Chip tone={p.capabilities.canUpdate ? 'ok' : 'neutral'}>update</Chip>
                          <Chip tone={p.capabilities.canLookup ? 'ok' : 'neutral'}>lookup</Chip>
                        </div>
                        {p.reason && <p className="note">{p.reason}</p>}
                      </div>
                    ))}
                    <p className="note note--caveat">{providers.data.note}</p>
                  </div>
                ) : (
                  <Unset />
                )}
              </Panel>
            </>
          }
        />
      )}

      <Drawer
        open={payloadOpen}
        onClose={() => setPayloadOpen(false)}
        title="Prepared CRM package"
        subtitle={payload.data?.mappingVersion}
        width={620}
      >
        {payload.loading ? (
          <LoadingState what="Reading the prepared package" rows={6} />
        ) : payload.data ? (
          <>
            <p className="note" style={{ marginBottom: 'var(--s4)' }}>{payload.data.note}</p>
            <pre className="payload">{JSON.stringify(payload.data.payload, null, 2)}</pre>
          </>
        ) : (
          <Unset what="No package held" />
        )}
      </Drawer>
    </EnginePage>
  )
}
