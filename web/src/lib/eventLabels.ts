// Turning stored event types into something a salesperson reads.
//
// This lived in the Intent Scoring screen, which is now locked for the demo
// phase. A pure label formatter is not scoring — it names an observed act and
// computes nothing — but leaving it there meant the Engagement timeline had to
// import from a locked screen to render a card. So it moved somewhere neutral:
// the lock is a presentation decision about numbers, and it should not be able
// to take an unrelated screen down with it.

/** "outreach_action_blocked" as a person would say it. */
export function prettyEvent(type: string): string {
  return type
    .replace(/^workbench_/, '')
    .replace(/^audit_report_/, 'report ')
    .replace(/^outreach_action_/, 'outreach ')
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
}
