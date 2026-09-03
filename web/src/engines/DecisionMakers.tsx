import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { useCompany } from '../lib/companyContext'
import { useEngine, EnginePage, EngineSplit } from '../components/shell/EnginePage'
import { Panel, Metric, MetricRow, Chip, Unset } from '../components/ui/primitives'
import { BlockedState, EmptyState, LoadingState } from '../components/ui/states'
import { RelationshipGraph } from '../components/motion/Signatures'
import { EvidenceButton } from '../components/ui/Evidence'
import type { DecisionMakerCandidate } from '../lib/types'

// Decision Makers (#978).
//
// This engine refuses to guess an email address, a phone number or a profile
// URL. Where a contact detail is absent the card says so — an inferred
// address would be worse than none, because somebody would try to use it.

export function DecisionMakers() {
  const engine = useEngine('decision-makers')
  const { company } = useCompany()
  const id = company?.crmCompanyId

  const candidates = useAsync<{ candidates: DecisionMakerCandidate[] }>(
    (signal) => api.get(`/decision-makers/companies/${id}/candidates`, { signal }),
    [id],
    { enabled: Boolean(id) },
  )

  const rows = candidates.data?.candidates ?? []
  const shortlisted = rows.filter((c) => c.outcome === 'shortlisted')
  const withEmail = rows.filter((c) => c.email).length
  const withPhone = rows.filter((c) => c.phone).length

  return (
    <EnginePage
      engineId="decision-makers"
      state={shortlisted.length ? 'success' : rows.length ? 'idle' : 'idle'}
      signature={<RelationshipGraph accent={engine.accent} count={rows.length} />}
    >
      {!company ? (
        <EmptyState title="Select a company" detail="Decision makers are discovered per company." />
      ) : candidates.loading && !candidates.data ? (
        <LoadingState what="Mapping people to this account" visual={<RelationshipGraph accent={engine.accent} />} />
      ) : (
        <EngineSplit
          main={
            <>
              <Panel title="Account map">
                <div className="viz">
                  <RelationshipGraph accent={engine.accent} count={rows.length} />
                  {rows.length === 0 && (
                    <div className="viz__empty">
                      <p>No people have been verified for this company.</p>
                    </div>
                  )}
                </div>
                <MetricRow>
                  <Metric label="Verified people" value={rows.length} size="sm" />
                  <Metric label="Shortlisted" value={shortlisted.length} accent size="sm" />
                  <Metric label="With an email" value={withEmail} size="sm" />
                  <Metric label="With a phone" value={withPhone} size="sm" />
                </MetricRow>
              </Panel>

              {rows.length === 0 ? (
                <EmptyState
                  title="Nobody verified yet"
                  detail="No decision maker has been discovered for this company. The engine will not invent one — a name it cannot evidence is not recorded."
                />
              ) : (
                <Panel title="Candidates" subtitle="Every person the engine could actually verify">
                  <ul className="people">
                    {rows.map((c, i) => (
                      <li key={c.id} className="people__card node-reveal" style={{ ['--i' as string]: i, ['--e' as string]: engine.accent }}>
                        <span className="people__avatar" aria-hidden="true">
                          {c.fullName.slice(0, 1).toUpperCase()}
                        </span>
                        <div className="people__body">
                          <div className="people__head">
                            <span className="people__name">{c.fullName}</span>
                            {c.outcome === 'shortlisted' ? (
                              <Chip tone="ok">Shortlisted</Chip>
                            ) : (
                              <Chip>{c.outcome.replace(/_/g, ' ')}</Chip>
                            )}
                          </div>
                          <p className="people__title">{c.rawTitle ?? <Unset what="Title not stated" />}</p>
                          <div className="row">
                            {c.roleGroup && <Chip tone="accent">{c.roleGroup.replace(/_/g, ' ')}</Chip>}
                            <Chip tone={c.confidence === 'high' ? 'ok' : c.confidence === 'medium' ? 'warn' : 'neutral'}>
                              {c.confidence} confidence
                            </Chip>
                            <Chip tone={c.contactability === 'none' ? 'neutral' : 'info'}>
                              {c.contactability.replace(/_/g, ' ')}
                            </Chip>
                          </div>
                          {/* Contact detail, or an explicit absence. */}
                          <div className="people__contact">
                            <span>{c.email ?? <Unset what="No email address recorded" />}</span>
                            <span>{c.phone ?? <Unset what="No phone number recorded" />}</span>
                          </div>
                        </div>
                        <EvidenceButton
                          title={c.fullName}
                          items={[
                            {
                              what: `${c.fullName}${c.rawTitle ? ` — ${c.rawTitle}` : ''}`,
                              source: c.profileUrl ? 'Public profile' : 'CRM contact record',
                              sourceUrl: c.profileUrl,
                              field: c.roleGroup ?? undefined,
                              how: `Company match: ${c.companyMatch.replace(/_/g, ' ')}. Confidence: ${c.confidence}.`,
                              reference: c.id,
                            },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </>
          }
          side={
            <>
              <Panel title="Contactability">
                <MetricRow>
                  <Metric label="Emails" value={withEmail} size="sm" />
                  <Metric label="Phones" value={withPhone} size="sm" />
                </MetricRow>
                {rows.length > 0 && withEmail === 0 && withPhone === 0 && (
                  <BlockedState
                    what="No contact details are available"
                    why="The engine verified these people but no source stated an email address or a phone number for any of them. It will not infer one from a name and a domain."
                    affects="The email and LinkedIn outreach channels have no destination for this company."
                    remediation="Configure a contact-data provider, or supply contact details another way."
                  />
                )}
              </Panel>

              <Panel title="Provider status">
                <p className="note">
                  Contact enrichment providers are configured at the platform level. Where none is authorised, this engine
                  reports what it could verify from the CRM and public pages alone.
                </p>
              </Panel>
            </>
          }
        />
      )}
    </EnginePage>
  )
}
