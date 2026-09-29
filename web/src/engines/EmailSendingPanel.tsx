import { api } from '../lib/api'
import { useAsync } from '../lib/hooks'
import { Panel, Chip, Field, Unset } from '../components/ui/primitives'
import { isSendingStatus } from './outreach/types'

// EMAIL SENDING — read-only (2026-09-28).
//
// What the server's .env allows: OFF (the platform sends nothing) or TEST
// (internal test inboxes only). There is no live mode and nothing to switch
// here; it is set by whoever runs the server.

export function EmailSendingPanel() {
  const state = useAsync<unknown>((signal) => api.get('/outreach/sequence/sending', { signal }), [])
  const s = isSendingStatus(state.data) ? state.data : null

  return (
    <Panel title="Email sending" subtitle="Set on the server — read-only here">
      {state.loading && !state.data ? (
        <Unset what="Loading…" />
      ) : !s ? (
        <Unset what="Could not be read" />
      ) : (
        <>
          <Field label="Mode" value={<Chip tone={s.mode === 'test' ? 'warn' : 'neutral'}>{s.mode === 'test' ? 'TEST — internal inboxes only' : 'OFF — nothing is sent'}</Chip>} />
          <Field label="Delivery" value={s.transport === 'smtp' ? 'Mail server (SMTP)' : 'Capture — recorded, nothing leaves the platform'} />
          <Field label="Test inbox" value={s.testInbox ?? <Unset what="Not set" />} />
          <Field label="Allowed test inboxes" value={s.allowList.length ? s.allowList.join(', ') : <Unset what="None" />} />
          {!s.ready && s.reason && <p className="note">{s.reason}</p>}
          <p className="note">Customer email is not sent by the platform in any mode.</p>
        </>
      )}
    </Panel>
  )
}
