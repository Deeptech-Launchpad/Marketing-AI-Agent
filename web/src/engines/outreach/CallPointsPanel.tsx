import { Phone } from 'lucide-react'
import { api } from '../../lib/api'
import { Button, Chip, Unset } from '../../components/ui/primitives'
import { useCall } from './useCall'
import { fmtDateTime, type CompanySequence } from './types'

// CALL TALKING POINTS — a short brief for a phone call, each point resting on
// a verified fact. A point the AI could not ground is dropped, not softened.

export function CallPointsPanel({ view, onChanged, canOperate }: { view: CompanySequence; onChanged: () => void; canOperate: boolean }) {
  const call = useCall(onChanged)
  const campaignId = view.campaign?.id
  const cp = view.callPoints
  const points = cp?.personalization?.points ?? []

  return (
    <div className="otr-calls">
      {call.error && (
        <p className="otr-err" role="alert">
          {call.error}
        </p>
      )}
      {cp ? (
        <>
          <ul className="otr-list">
            {points.length > 0
              ? points.map((p, i) => (
                  <li key={i}>
                    <span>{p.text}</span>
                    <span className="cell-dim">
                      {p.source === 'ai' ? 'Written from' : 'From'}: {p.factIds.join(', ')}
                    </span>
                  </li>
                ))
              : cp.body
                  .split('\n')
                  .filter(Boolean)
                  .map((line, i) => <li key={i}>{line}</li>)}
          </ul>
          <p className="cell-dim">
            Prepared {fmtDateTime(cp.updatedAt)}
            {(cp.personalization?.dropped?.length ?? 0) > 0 && ` · ${cp.personalization!.dropped!.length} point(s) dropped as unsupported`}
          </p>
        </>
      ) : (
        <Unset what="No talking points prepared yet" />
      )}
      {canOperate && campaignId && (
        <div className="row" style={{ marginTop: 'var(--s3)' }}>
          <Button
            icon={Phone}
            size="sm"
            busy={call.busy === 'points'}
            onClick={() => void call.run('points', () => api.post(`/outreach/sequence/campaigns/${campaignId}/call-points`, {}))}
          >
            {cp ? 'Refresh talking points' : 'Prepare talking points'}
          </Button>
          <Chip>Nothing is dialled — the call is yours</Chip>
        </div>
      )}
    </div>
  )
}
