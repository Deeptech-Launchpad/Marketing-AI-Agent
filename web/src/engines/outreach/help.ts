// Short, plain explanations behind each (i) button on the Outreach screens.
// Two lines at most: what it is, and what to do next. No jargon.

export interface Help {
  title: string
  what: string
  next?: string
}

export const HELP = {
  outreach: {
    title: 'Outreach',
    what: 'Emails to a company, written from our approved Sales templates and filled in with what we verified about that company.',
    next: 'Pick a company on the right, then follow the steps at the top.',
  },
  flow: {
    title: 'The outreach steps',
    what: 'Company → decision maker → email draft → review and edit → approve → send → follow-ups. The highlighted step is where this company is now.',
    next: 'Do the highlighted step. The button for it is in the "Next step" box.',
  },
  sequence: {
    title: 'Sequence',
    what: 'The planned set of emails for one company: the first email, then follow-ups on fixed days if they do not reply.',
    next: 'You only act when a step says "Prepare", "Review" or "Send".',
  },
  versions: {
    title: 'V1 / V2 / V3',
    what: 'Three approved wordings of the first email. Each company gets one, rotated so we can see which works best.',
    next: 'Keep the suggested version, or switch before you approve.',
  },
  draft: {
    title: 'Draft',
    what: 'An email the platform wrote for you. Nothing goes out until someone approves it.',
    next: 'Read it, fix anything that is wrong, then approve.',
  },
  approval: {
    title: 'Approval',
    what: 'A person confirming this exact email may be sent. Every item in the checklist must be ticked first.',
    next: 'Fix any red item, then click Approve. Editing after approval sends it back for review.',
  },
  checklist: {
    title: 'Before approval checklist',
    what: 'Checks that must pass: no blanks left, the right recipient, the sender set up, and the company not blocked.',
    next: 'Each red item says what to do.',
  },
  testEmail: {
    title: 'Test email',
    what: 'Sends this exact email to your own inbox (never to the customer), so you can see how it arrives.',
    next: 'Click it, then check your inbox and spam folder.',
  },
  schedule: {
    title: 'Schedule',
    what: 'When approved emails go out: the first send time, the hours and days allowed, the gap between companies, and a daily limit. Follow-up days are fixed by the template.',
    next: 'Set the first send time and hours, then review.',
  },
  send: {
    title: 'Sending',
    what: 'After approval, send the email from your own account. "Open in Gmail" opens a compose window with the address, subject and text already filled in. Then click "Mark as sent" so the follow-ups can start.',
    next: 'Open it in Gmail, send it, then mark it sent.',
  },
  followUp: {
    title: 'Follow-ups',
    what: 'If the company does not reply, follow-up emails are due on set days after the first email. If they reply, the remaining follow-ups stop by themselves.',
    next: 'When a follow-up is due, prepare it, review it and approve it like the first email.',
  },
  replies: {
    title: 'Replies',
    what: 'Paste the customer’s reply here. The platform suggests what kind of reply it is; you confirm. Confirming stops the remaining no-reply follow-ups.',
    next: 'Paste the reply, check the suggestion, click Confirm.',
  },
  sendingStatus: {
    title: 'Sending status',
    what: 'Whether this platform can send email right now. OFF: you send from your own mail program. TEST MODE: the platform only sends to internal test inboxes, never to customers.',
    next: 'Nothing to do here. It is set on the server.',
  },
  productPage: {
    title: 'Product page link',
    what: 'The link to this company’s own product page that we checked. It is added to the first email only if it was verified. We never guess or use another site’s link.',
    next: 'Click it to check it opens the right product before you approve.',
  },
  recipient: {
    title: 'Decision maker and recipient',
    what: 'The person the email is written to, and the address it goes to: their own email, or the company’s verified mailbox if they have none.',
    next: 'Check the name and address are right. If no address is shown, enter one.',
  },
  emailStatus: {
    title: 'Email status',
    what: 'Waiting for approval → Ready to send → Scheduled → Sent. Failed means it did not go and can be retried. Stopped means the company replied, so it is no longer needed.',
    next: 'Open any email to see what it needs.',
  },
  batches: {
    title: 'Several companies (test run)',
    what: 'Drafts the first email for up to 10 companies at once. Each email still needs its own approval. In test mode they go only to the internal test inbox.',
    next: 'Choose companies, set the schedule, then approve each draft.',
  },
} satisfies Record<string, Help>

export type HelpKey = keyof typeof HELP
