// ONE vocabulary for the state of an email, used everywhere on the Outreach
// screens: the email list, the sequence, the draft, and the batch table.

export type Tone = 'ok' | 'warn' | 'danger' | 'accent' | 'info' | 'neutral'

export interface EmailStatus {
  label: string
  tone: Tone
}

const REPLIED = /prospect replied/i

/**
 * What an email's status means to a person. `status` is the stored action
 * status; `reason` explains a cancellation; `isTest` marks a test-run email.
 */
export function emailStatus(status: string | null | undefined, reason?: string | null, isTest = false): EmailStatus {
  switch (status) {
    case 'draft':
      return { label: 'Waiting for approval', tone: 'info' }
    case 'ready_to_send':
      return { label: isTest ? 'Approved — not scheduled' : 'Ready to send', tone: 'accent' }
    case 'scheduled':
    case 'sending':
      return { label: 'Scheduled', tone: 'accent' }
    case 'sent':
      return { label: isTest ? 'Sent (test inbox)' : 'Sent', tone: 'ok' }
    case 'failed':
      return { label: 'Failed', tone: 'danger' }
    case 'cancelled':
      return REPLIED.test(reason ?? '') ? { label: 'Stopped — they replied', tone: 'neutral' } : { label: 'Cancelled', tone: 'neutral' }
    case 'skipped':
      return { label: 'Skipped', tone: 'neutral' }
    default:
      return { label: status ? status.replace(/_/g, ' ') : 'Not started', tone: 'neutral' }
  }
}

/** A sequence step with no email yet. */
export function stepStatus(stageStatus: string): EmailStatus {
  switch (stageStatus) {
    case 'due':
      return { label: 'Follow-up due — prepare it', tone: 'warn' }
    case 'overdue':
      return { label: 'Overdue', tone: 'danger' }
    case 'upcoming':
      return { label: 'Follow-up pending', tone: 'neutral' }
    case 'not_applicable':
      return { label: 'Not needed', tone: 'neutral' }
    case 'skipped':
      return { label: 'Skipped', tone: 'neutral' }
    case 'done':
      return { label: 'Sent', tone: 'ok' }
    case 'approved':
      return { label: 'Ready to send', tone: 'accent' }
    case 'scheduled':
      return { label: 'Scheduled', tone: 'accent' }
    case 'drafted':
      return { label: 'Waiting for approval', tone: 'info' }
    default:
      return { label: stageStatus.replace(/_/g, ' '), tone: 'neutral' }
  }
}

/** The legend shown once on the screen, in the order an email moves through. */
export const STATUS_LEGEND: EmailStatus[] = [
  { label: 'Waiting for approval', tone: 'info' },
  { label: 'Ready to send', tone: 'accent' },
  { label: 'Scheduled', tone: 'accent' },
  { label: 'Sent', tone: 'ok' },
  { label: 'Failed', tone: 'danger' },
  { label: 'Follow-up pending', tone: 'neutral' },
  { label: 'Stopped — they replied', tone: 'neutral' },
]
