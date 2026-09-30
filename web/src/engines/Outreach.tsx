import { useCallback, useState } from 'react'
import { ArrowLeft, FileEdit, Pause, Play, Square } from 'lucide-react'
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
import { TestBatches } from './outreach/TestBatches'
import { InfoTip } from './outreach/InfoTip'
import { STATUS_LEGEND, emailStatus } from './outreach/status'
import {
  APPROVED_UNSENT,
  PHASE_LABEL,
  fmtDateTime,
  fmtWindow,
  isCompanySequence,
  isSendingStatus,
  type CompanySequence,
  type Draft,
  type ProspectRow,
  type SendingStatus,
} from './outreach/types'
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
// mail client. There is no customer-send control on this screen, and it never
// calls the legacy /release or /execute endpoints.
//
// TEST MODE (2026-09-28): the "Test batches" view rehearses the sequence for up
// to 10 companies. Approved test emails are delivered by the platform to the
// INTERNAL test inboxes only; the banner always says whether sending is off or
// in test mode. There is no live mode.

const FLOW_STEPS = ['Company', 'Decision maker', 'Email draft', 'Review & edit', 'Approve', 'Send', 'Follow-ups'] as const

/** Which of the steps this company is on now (0-based). */
function currentStep(view: CompanySequence | null, hasCompany: boolean): number {
  if (!hasCompany || !view) return 0
  if (!view.gate.ready) return 1
  if (!view.campaign) return 2
  const initial = view.drafts.find((d) => d.stageKey === 'initial' && d.status !== 'cancelled') ?? null
  if (!initial) return 2
  if (initial.status === 'draft') return initial.gates?.ok ? 4 : 3
  if (initial.status === 'sent') return 6
  return 5
}

export function Outreach() {
  const { can } = useAuth()
  const { company, select } = useCompany()
  const engine = useEngine('outreach')
  const id = company?.crmCompanyId ?? null
  const canOperate = can('operate')
  const canApprove = can('approve')

  const [tab, setTab] = useState<'sequences' | 'batches'>('sequences')
  const [testCampaign, setTestCampaign] = useState<{ crmCompanyId: string; companyName: string; campaignId: string } | null>(null)
  // In the test view, the company workspace shows one TEST campaign; otherwise
  // the selected company's real sequence.
  const viewId = tab === 'batches' ? testCampaign?.crmCompanyId ?? null : id
  const viewCampaign = tab === 'batches' ? testCampaign?.campaignId ?? null : null

  const sendingState = useAsync<unknown>((signal) => api.get('/outreach/sequence/sending', { signal }), [])
  const sending: SendingStatus | null = isSendingStatus(sendingState.data) ? sendingState.data : null

  const prospects = useAsync<unknown>((signal) => api.get('/outreach/sequence/prospects', { signal }), [])
  const rows: ProspectRow[] = Array.isArray((prospects.data as { prospects?: unknown } | null)?.prospects)
    ? ((prospects.data as { prospects: ProspectRow[] }).prospects)
    : []

  const viewState = useAsync<unknown>(
    (signal) =>
      viewId
        ? api.get(`/outreach/sequence/companies/${encodeURIComponent(viewId)}${viewCampaign ? `?campaign=${encodeURIComponent(viewCampaign)}` : ''}`, { signal })
        : Promise.resolve(null),
    [viewId, viewCampaign],
    { enabled: Boolean(viewId) },
  )
  const view: CompanySequence | null = viewId && isCompanySequence(viewState.data) ? viewState.data : null

  const refresh = useCallback(() => {
    viewState.refresh()
    prospects.refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewState.refresh, prospects.refresh])

  const call = useCall(refresh)
  const [openDraftId, setOpenDraftId] = useState<string | null>(null)
  const openDraft: Draft | null = view?.drafts.find((d) => d.actionId === openDraftId) ?? null

  const start = () => void call.run('start', () => api.post(`/outreach/sequence/companies/${encodeURIComponent(id!)}/start`, {}))

  const canStart = tab === 'sequences' && canOperate && id && view && !view.campaign && view.gate.ready
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
            <SendingBanner sending={sending} />
            <div className="row otr-tabs">
              <div className="otr-seg" role="group" aria-label="Outreach view">
                <button type="button" className="otr-seg__btn" aria-pressed={tab === 'sequences'} onClick={() => setTab('sequences')}>
                  One company
                </button>
                <button type="button" className="otr-seg__btn" aria-pressed={tab === 'batches'} onClick={() => setTab('batches')}>
                  Several companies (test run)
                </button>
              </div>
              <InfoTip topic={tab === 'batches' ? 'batches' : 'outreach'} />
            </div>

            {tab === 'sequences' && <FlowGuide step={currentStep(view, Boolean(id))} />}

            {call.error && <ErrorState error={new Error(call.error)} what="That outreach step did not complete" />}

            {tab === 'batches' && !testCampaign && (
              <TestBatches
                sending={sending}
                canOperate={canOperate}
                onOpenCampaign={(c) => {
                  setOpenDraftId(null)
                  setTestCampaign(c)
                }}
              />
            )}

            {tab === 'batches' && testCampaign && (
              <div className="row">
                <Button
                  size="sm"
                  variant="quiet"
                  icon={ArrowLeft}
                  onClick={() => {
                    setOpenDraftId(null)
                    setTestCampaign(null)
                  }}
                >
                  Back to the test batch
                </Button>
                <Chip tone="warn">Test run · {testCampaign.companyName}</Chip>
              </div>
            )}

            {tab === 'sequences' && !id && (
              <EmptyState
                title="Step 1: choose a company"
                detail="Pick a company from the list on the right, or from the company picker at the top. Its decision maker, email draft and next step will appear here."
              />
            )}

            {viewId && viewState.loading && !view && (
              <LoadingState what="Reading this company's outreach" visual={<SequencePath accent={engine.accent} />} />
            )}

            {viewId && viewState.error && !view && (
              <ErrorState error={viewState.error} what="The outreach for this company could not be read" onRetry={viewState.refresh} />
            )}

            {view && <CompanyWorkspace view={view} canOperate={canOperate} canApprove={canApprove} onOpenDraft={(d) => setOpenDraftId(d.actionId)} onChanged={refresh} />}
          </>
        }
        side={
          <>
            <Panel title="Companies in outreach" subtitle="What needs doing first is at the top">
              {prospects.loading && !prospects.data ? (
                <Unset what="Loading…" />
              ) : prospects.error ? (
                <ErrorState error={prospects.error} what="The prospect list could not be read" onRetry={prospects.refresh} />
              ) : (
                <ProspectList rows={rows} selectedId={id} onSelect={pickProspect} />
              )}
            </Panel>

            <Panel
              title={
                <span className="row">
                  What the statuses mean <InfoTip topic="emailStatus" />
                </span>
              }
            >
              <ul className="otr-legend">
                {STATUS_LEGEND.map((s) => (
                  <li key={s.label}>
                    <Chip tone={s.tone}>{s.label}</Chip>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel
              title={
                <span className="row">
                  How sending works <InfoTip topic="send" />
                </span>
              }
            >
              <p className="note">
                Nothing is sent without approval. After you approve an email, click Open in Gmail — the address, subject and text are filled
                in for you — send it from your own account, then click Mark as sent, which starts the follow-up timer.
              </p>
              <p className="note">Test runs send only to the internal test inbox. They never reach a customer and never count as contact.</p>
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
          sending={sending}
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
  const isTest = Boolean(campaign?.isTest)
  const liveDrafts = view.drafts.filter((d) => d.status === 'draft' || APPROVED_UNSENT.includes(d.status))
  const nextDraft = seq?.next.stageKey ? view.drafts.find((d) => d.stageKey === seq.next.stageKey && d.status !== 'cancelled') ?? null : null
  const nextStage = seq?.next.stageKey ? seq.stages.find((s) => s.stageKey === seq.next.stageKey) ?? null : null

  return (
    <>
      {!view.sender.configured && (
        <BlockedState
          what="The sender is not set up"
          why="Every email is signed with the name of the person who starts the outreach (their NXT Sales login) and the company name. One of them is missing."
          affects="Drafts can be prepared and reviewed, but none can be approved."
          remediation="An administrator sets the company name in Settings → Outreach sender. If your name is missing, ask an admin to add it to your NXT Sales user."
        />
      )}

      {!view.gate.ready && (
        <BlockedState
          what="Outreach cannot start yet — no decision maker"
          why={view.gate.reason ?? 'This company is not ready for outreach.'}
          affects="No draft can be prepared for this company. Nothing has been sent."
          remediation="Open Decision Makers for this company, run it, then come back here."
        />
      )}

      <WhoPanel view={view} />

      {!campaign && view.gate.ready && (
        <EmptyState
          title="Next: create the email draft"
          detail={
            canOperate
              ? 'Click "Start outreach" (top right). The first email is written from the approved template for this company, for you to review — nothing is sent.'
              : 'Someone with operate permission can start outreach for this company.'
          }
        />
      )}

      {campaign && seq && (
        <>
          <Panel
            title={
              <span className="row">
                Next step <InfoTip topic="flow" />
              </span>
            }
            subtitle={`${PHASE_LABEL[seq.phase] ?? seq.phase}${seq.initialSentAt ? ` · first email sent ${fmtDateTime(seq.initialSentAt)}` : ''}`}
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
              <p className="otr-next__text">
              {isTest && nextStage?.status === 'approved'
                ? `${nextStage.pdfRef} ${nextStage.label}: approved, but not on the test schedule — open it to schedule or retry the test send.`
                : seq.next.text}
            </p>
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
            <Panel
              title={
                <span className="row">
                  Emails that need you <InfoTip topic="draft" />
                </span>
              }
              subtitle={isTest ? 'Drafts to approve, and approved test emails waiting for their time' : 'Drafts to approve, and approved emails for you to send'}
            >
              <ul className="otr-drafts">
                {liveDrafts.map((d) => (
                  <li key={d.actionId}>
                    <span className="otr-drafts__ref mono">{d.pdfRef}</span>
                    <span className="otr-drafts__name">
                      {d.label}
                      {d.version ? ` · ${d.version.toUpperCase()}` : ''}
                    </span>
                    <Chip tone={emailStatus(d.status, d.statusReason, isTest).tone}>{emailStatus(d.status, d.statusReason, isTest).label}</Chip>
                    {d.scheduledAt && <span className="cell-dim">{fmtDateTime(d.scheduledAt)}</span>}
                    {d.gates && !d.gates.ok && d.status === 'draft' && (
                      <span className="cell-dim">{d.gates.items.filter((g) => !g.ok).length} item(s) before approval</span>
                    )}
                    <Button size="sm" icon={FileEdit} onClick={() => onOpenDraft(d)}>
                      {d.status === 'draft' ? (canApprove ? 'Review & approve' : 'Open') : 'Open'}
                    </Button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel
            title={
              <span className="row">
                Sequence and follow-ups <InfoTip topic="sequence" /> <InfoTip topic="followUp" label="a follow-up" />
              </span>
            }
            subtitle="Every planned email for this company, when it is due, and its status"
          >
            <SequenceTimeline view={view} onOpenDraft={onOpenDraft} onChanged={onChanged} canOperate={canOperate} />
          </Panel>

          <Panel
            title={
              <span className="row">
                Replies <InfoTip topic="replies" />
              </span>
            }
            subtitle="Paste their reply; confirm what kind it is. A reply stops the remaining follow-ups."
          >
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

/** The step guide: Company → Decision maker → … → Follow-ups, with this company's step highlighted. */
function FlowGuide({ step }: { step: number }) {
  return (
    <div className="otr-flow" aria-label="Outreach steps">
      <ol className="otr-flow__list">
        {FLOW_STEPS.map((label, i) => (
          <li key={label} className={`otr-flow__step ${i < step ? 'is-done' : i === step ? 'is-now' : ''}`} aria-current={i === step ? 'step' : undefined}>
            <span className="otr-flow__n">{i + 1}</span>
            <span className="otr-flow__label">{label}</span>
          </li>
        ))}
      </ol>
      <InfoTip topic="flow" />
    </div>
  )
}

/** Who the email is for, where it goes, and which product page it links to. */
function WhoPanel({ view }: { view: CompanySequence }) {
  const f = view.facts
  const dm = f.decisionMaker
  const recipient = view.campaign?.recipientEmail ?? dm?.email ?? dm?.companyContactEmail?.email ?? null
  const source =
    view.campaign?.recipientEmailSource === 'sales_entered'
      ? 'entered by Sales'
      : (view.campaign?.recipientEmailSource ?? (dm?.email ? 'decision_maker' : dm?.companyContactEmail ? 'company_mailbox' : null)) === 'company_mailbox'
        ? 'company mailbox — this person has no direct email'
        : recipient
          ? "the decision maker's own email"
          : null
  return (
    <Panel
      title={
        <span className="row">
          Who we are emailing <InfoTip topic="recipient" />
        </span>
      }
    >
      <Field label="Company" value={f.companyName} />
      <Field label="Decision maker" value={dm ? `${dm.fullName}${dm.title ? ` · ${dm.title}` : ''}` : <Unset what="None found yet — run Decision Makers" />} />
      <Field
        label="Email goes to"
        value={
          recipient ? (
            <span>
              {recipient} <span className="cell-dim">({source})</span>
            </span>
          ) : (
            <Unset what="No address on record — you can enter one in the draft" />
          )
        }
      />
      <Field
        label="Product page link"
        value={
          <span className="row">
            {f.productPageUrl ? (
              <a className="cell-link" href={f.productPageUrl} target="_blank" rel="noreferrer noopener">
                {f.productPageUrl}
              </a>
            ) : (
              <Unset what={f.productPageNote ?? 'No verified product page — the email will not include a link'} />
            )}
            <InfoTip topic="productPage" />
          </span>
        }
      />
      {view.campaign?.initialVersion && (
        <Field
          label="First email version"
          value={
            <span className="row">
              {view.campaign.initialVersion.toUpperCase()} ({view.campaign.versionSource === 'sales_override' ? 'chosen by Sales' : 'rotated automatically'})
              <InfoTip topic="versions" />
            </span>
          }
        />
      )}
    </Panel>
  )
}

/** Always visible: whether the platform can send anything, and where it would go. */
function SendingBanner({ sending }: { sending: SendingStatus | null }) {
  if (!sending) return null
  if (sending.mode !== 'test') {
    return (
      <p className="otr-banner is-off" role="status">
        <strong>Email sending: OFF.</strong> The platform sends nothing. You send approved emails from your own mail program.{' '}
        <InfoTip topic="sendingStatus" />
      </p>
    )
  }
  return (
    <p className={`otr-banner is-test${sending.ready ? '' : ' is-blocked'}`} role="status">
      <InfoTip topic="sendingStatus" />{' '}
      <strong>TEST MODE.</strong> Test emails go only to internal test inboxes
      {sending.testInbox ? ` (${sending.testInbox})` : ''} via {sending.transport === 'smtp' ? 'the mail server' : 'capture — nothing leaves the platform'}.
      Customers are never emailed.
      {!sending.ready && sending.reason ? ` Not ready: ${sending.reason}` : ''}
    </p>
  )
}
