import { useCallback, useState } from 'react'
import { FileEdit, Pause, Play, Square } from 'lucide-react'
import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { useAuth } from '../lib/auth'
import { useCompany } from '../lib/companyContext'
import { Panel, Chip, Button, Field, Unset } from '../components/ui/primitives'
import { BlockedState, EmptyState, ErrorState, LoadingState } from '../components/ui/states'
import { SequencePath } from '../components/motion/Signatures'
import { DraftEditor } from './outreach/DraftEditor'
import { OutreachHistory, SequenceTimeline } from './outreach/SequenceTimeline'
import { ReplyPanel } from './outreach/ReplyPanel'
import { CallPointsPanel } from './outreach/CallPointsPanel'
import { ProspectList } from './outreach/ProspectList'
import { useCall } from './outreach/useCall'
import { PHASE_LABEL, fmtDateTime, fmtWindow, isCompanySequence, type CompanySequence, type Draft, type ProspectRow } from './outreach/types'
import './outreach/outreach.css'

// OUTREACH — THE SALES-APPROVED EMAIL SEQUENCE (2026-09-26).
//
// Built on the approved content in "Final - Email Outreach Content by
// Countries.pdf" (USA): three initial versions, the reply and no-reply
// follow-ups, the expo invitation and the break-up, each on its own timing.
//
// The platform prepares every email as a draft — the approved words, filled
// from verified facts, with at most one AI-written line that must cite them —
// and Sales reviews, edits, approves and sends it themselves from their own
// mail client. There is no send control on this screen, and it never calls the
// legacy /release or /execute endpoints.

const STATUS_WORD: Record<string, string> = {
  draft: 'Draft',
  ready_to_send: 'Approved',
  sent: 'Sent',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
}

export function Outreach() {
  const { can } = useAuth()
  const { company, select } = useCompany()
  const engine = useEngine('outreach')
  const id = company?.crmCompanyId ?? null
  const canOperate = can('operate')
  const canApprove = can('approve')

  const prospects = useAsync<unknown>((signal) => api.get('/outreach/sequence/prospects', { signal }), [])
  const rows: ProspectRow[] = Array.isArray((prospects.data as { prospects?: unknown } | null)?.prospects)
    ? ((prospects.data as { prospects: ProspectRow[] }).prospects)
    : []

  const viewState = useAsync<unknown>(
    (signal) => (id ? api.get(`/outreach/sequence/companies/${encodeURIComponent(id)}`, { signal }) : Promise.resolve(null)),
    [id],
    { enabled: Boolean(id) },
  )
  const view: CompanySequence | null = isCompanySequence(viewState.data) ? viewState.data : null

  const refresh = useCallback(() => {
    viewState.refresh()
    prospects.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewState.refresh, prospects.refresh])

  const call = useCall(refresh)
  const [openDraftId, setOpenDraftId] = useState<string | null>(null)
  const openDraft: Draft | null = view?.drafts.find((d) => d.actionId === openDraftId) ?? null

  const start = () => void call.run('start', () => api.post(`/outreach/sequence/companies/${encodeURIComponent(id!)}/start`, {}))

  const canStart = canOperate && id && view && !view.campaign && view.gate.ready
  const action = canStart ? (
    <Button icon={FileEdit} variant="primary" onClick={start} busy={call.busy === 'start'}>
      Start outreach
    </Button>
  ) : null

  const pickProspect = (r: ProspectRow) => select?.({ crmCompanyId: r.crmCompanyId, companyName: r.companyName })

  return (
    <EnginePage
      engineId="outreach"
      state={call.busy ? 'running' : 'idle'}
      signature={<SequencePath accent={engine.accent} />}
      actions={action}
    >
      <EngineSplit
        main={
          <>
            {call.error && <ErrorState error={new Error(call.error)} what="That outreach step did not complete" />}

            {!id && (
              <EmptyState
                title="Choose a company"
                detail="Pick a company from the prospects on the right, or select one in the company picker, to see its outreach."
              />
            )}

            {id && viewState.loading && !view && (
              <LoadingState what="Reading this company's outreach" visual={<SequencePath accent={engine.accent} />} />
            )}

            {id && viewState.error && !view && (
              <ErrorState error={viewState.error} what="The outreach for this company could not be read" onRetry={viewState.refresh} />
            )}

            {view && <CompanyWorkspace view={view} canOperate={canOperate} canApprove={canApprove} onOpenDraft={(d) => setOpenDraftId(d.actionId)} onChanged={refresh} />}
          </>
        }
        side={
          <>
            <Panel title="Prospects in the sequence" subtitle="What needs doing first is at the top">
              {prospects.loading && !prospects.data ? (
                <Unset what="Loading…" />
              ) : prospects.error ? (
                <ErrorState error={prospects.error} what="The prospect list could not be read" onRetry={prospects.refresh} />
              ) : (
                <ProspectList rows={rows} selectedId={id} onSelect={pickProspect} />
              )}
            </Panel>

            {view && <FactsPanel view={view} />}

            <Panel title="How sending works">
              <p className="note">
                Every email is a draft until Sales approves it. Approved emails are sent by a person from their own mail client and then
                marked sent here. This platform does not send email, and no step runs on its own.
              </p>
            </Panel>
          </>
        }
      />

      {view && (
        <DraftEditor
          draft={openDraft}
          view={view}
          open={Boolean(openDraft)}
          onClose={() => setOpenDraftId(null)}
          onChanged={refresh}
          canOperate={canOperate}
          canApprove={canApprove}
        />
      )}
    </EnginePage>
  )
}

function CompanyWorkspace({
  view,
  canOperate,
  canApprove,
  onOpenDraft,
  onChanged,
}: {
  view: CompanySequence
  canOperate: boolean
  canApprove: boolean
  onOpenDraft: (d: Draft) => void
  onChanged: () => void
}) {
  const call = useCall(onChanged)
  const seq = view.sequence
  const campaign = view.campaign
  const liveDrafts = view.drafts.filter((d) => d.status === 'draft' || d.status === 'ready_to_send')
  const nextDraft = seq?.next.stageKey ? view.drafts.find((d) => d.stageKey === seq.next.stageKey && d.status !== 'cancelled') ?? null : null
  const nextStage = seq?.next.stageKey ? seq.stages.find((s) => s.stageKey === seq.next.stageKey) ?? null : null

  return (
    <>
      {!view.sender.configured && (
        <BlockedState
          what="No sender is configured"
          why="Every approved email is signed with the sender's name and company, and none has been set."
          affects="Drafts can be prepared and reviewed, but none can be approved."
          remediation="An administrator sets the sender in Settings → Outreach sender."
        />
      )}

      {!view.gate.ready && (
        <BlockedState
          what="Outreach cannot start yet"
          why={view.gate.reason ?? 'This company is not ready for outreach.'}
          affects="No draft can be prepared for this company. Nothing has been sent."
          remediation="Run Decision Makers for this company, then return here."
        />
      )}

      {!campaign && view.gate.ready && (
        <EmptyState
          title="Outreach has not started for this company"
          detail={
            canOperate
              ? 'Start outreach to prepare the initial email for review. It is drafted from the approved copy and sent by you, not by the platform.'
              : 'Someone with operate permission can start outreach for this company.'
          }
        />
      )}

      {campaign && seq && (
        <>
          <Panel
            title="Next action"
            subtitle={`${PHASE_LABEL[seq.phase] ?? seq.phase}${seq.initialSentAt ? ` · initial email sent ${fmtDateTime(seq.initialSentAt)}` : ''}`}
            actions={
              canOperate && (
                <div className="row">
                  {campaign.status === 'active' && (
                    <Button size="sm" variant="quiet" icon={Pause} busy={call.busy === 'pause'} onClick={() => void call.run('pause', () => api.post(`/outreach/sequence/campaigns/${campaign.id}/pause`, {}))}>
                      Pause
                    </Button>
                  )}
                  {campaign.status === 'paused' && (
                    <Button size="sm" icon={Play} busy={call.busy === 'resume'} onClick={() => void call.run('resume', () => api.post(`/outreach/sequence/campaigns/${campaign.id}/resume`, {}))}>
                      Resume
                    </Button>
                  )}
                  {(campaign.status === 'active' || campaign.status === 'paused') && (
                    <Button size="sm" variant="danger" icon={Square} busy={call.busy === 'stop'} onClick={() => void call.run('stop', () => api.post(`/outreach/sequence/campaigns/${campaign.id}/stop`, {}))}>
                      Stop sequence
                    </Button>
                  )}
                </div>
              )
            }
          >
            {call.error && (
              <p className="otr-err" role="alert">
                {call.error}
              </p>
            )}
            <div className={`otr-next${seq.next.overdue ? ' is-overdue' : ''}`}>
              <p className="otr-next__text">{seq.next.text}</p>
              <div className="row">
                {seq.next.window && <Chip tone={seq.next.overdue ? 'danger' : 'info'}>Due {fmtWindow(seq.next.window)}</Chip>}
                {seq.next.overdue && <Chip tone="danger">Overdue</Chip>}
                {nextDraft && (
                  <Button size="sm" icon={FileEdit} variant="primary" onClick={() => onOpenDraft(nextDraft)}>
                    {nextDraft.status === 'draft' ? 'Review draft' : 'Open email'}
                  </Button>
                )}
                {!nextDraft && nextStage?.canPrepare && canOperate && (
                  <Button
                    size="sm"
                    icon={FileEdit}
                    variant="primary"
                    busy={call.busy === 'prepare'}
                    onClick={() => void call.run('prepare', () => api.post(`/outreach/sequence/campaigns/${campaign.id}/stages/${nextStage.stageKey}/prepare`, {}))}
                  >
                    Prepare draft
                  </Button>
                )}
              </div>
            </div>
            {campaign.statusReason && campaign.status !== 'active' && <p className="note">{campaign.statusReason}</p>}
          </Panel>

          {liveDrafts.length > 0 && (
            <Panel title="Emails in review" subtitle="Drafts waiting for a decision, and approved emails waiting to be sent by you">
              <ul className="otr-drafts">
                {liveDrafts.map((d) => (
                  <li key={d.actionId}>
                    <span className="otr-drafts__ref mono">{d.pdfRef}</span>
                    <span className="otr-drafts__name">
                      {d.label}
                      {d.version ? ` · ${d.version.toUpperCase()}` : ''}
                    </span>
                    <Chip tone={d.status === 'ready_to_send' ? 'accent' : 'info'}>{STATUS_WORD[d.status] ?? d.status}</Chip>
                    {d.gates && !d.gates.ok && d.status === 'draft' && (
                      <span className="cell-dim">{d.gates.items.filter((g) => !g.ok).length} item(s) before approval</span>
                    )}
                    <Button size="sm" icon={FileEdit} onClick={() => onOpenDraft(d)}>
                      {d.status === 'draft' ? (canApprove ? 'Review' : 'Open') : 'Open'}
                    </Button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Sequence" subtitle="The approved stages, their timing and where this prospect is">
            <SequenceTimeline view={view} onOpenDraft={onOpenDraft} onChanged={onChanged} canOperate={canOperate} />
          </Panel>

          <Panel title="Replies" subtitle="Paste a reply; the AI reads it and you confirm before anything changes">
            <ReplyPanel view={view} onChanged={onChanged} canOperate={canOperate} />
          </Panel>

          <Panel title="Call talking points" subtitle="For a phone call, from verified facts only">
            <CallPointsPanel view={view} onChanged={onChanged} canOperate={canOperate} />
          </Panel>

          <Panel title="Outreach history" subtitle="Every change, who made it and when">
            <OutreachHistory view={view} />
          </Panel>
        </>
      )}
    </>
  )
}

function FactsPanel({ view }: { view: CompanySequence }) {
  const f = view.facts
  return (
    <Panel title="What the emails can draw on" subtitle="Verified facts only">
      <Field label="Company" value={f.companyName} />
      <Field
        label="Decision maker"
        value={f.decisionMaker ? `${f.decisionMaker.fullName}${f.decisionMaker.title ? ` · ${f.decisionMaker.title}` : ''}` : <Unset what="None shortlisted" />}
      />
      <Field label="Email" value={f.decisionMaker?.email ?? <Unset what="Not on record" />} />
      <Field
        label="Product analysed"
        value={
          f.product ? (
            f.product.url ? (
              <a className="cell-link" href={f.product.url} target="_blank" rel="noreferrer noopener">
                {f.product.name}
              </a>
            ) : (
              f.product.name
            )
          ) : (
            <Unset what="No product analysis" />
          )
        }
      />
      <Field label="Active intent signals" value={String((f.signals ?? []).length)} />
      {view.campaign && (
        <Field
          label="Initial version"
          value={view.campaign.initialVersion ? `${view.campaign.initialVersion.toUpperCase()} (${view.campaign.versionSource === 'sales_override' ? 'chosen by Sales' : 'rotation'})` : <Unset />}
        />
      )}
    </Panel>
  )
}
