import type { HelpText } from '../components/ui/InfoTip'

// The (i) beside each engine's title: what the engine does, in plain words,
// and what to do on this screen. Short on purpose — two lines, no jargon.

export const ENGINE_HELP: Record<string, HelpText> = {
  prospect: {
    title: 'Prospect Discovery',
    what: 'Finds companies on the public web that match what you describe — industry, products, location — with their website, location and a real product page. Unrelated sites are filtered out.',
    next: 'Describe the companies you want and search. Open a company to check it, then run Enrichment for it.',
  },
  enrichment: {
    title: 'Company Enrichment',
    what: 'Reads the company’s own website and records the technology it uses (e-commerce platform, CMS, analytics and more), with the evidence for each finding.',
    next: 'Select a company and run Enrichment. Check the findings, then go to Intent Signals.',
  },
  intent: {
    title: 'Intent Signals',
    what: 'Finds public signs a company may need us — news, forum and Reddit discussions, reviews, community questions, technology changes — each with its source link and date. Weak or unrelated items and job postings are left out.',
    next: 'Select a company and run Intent Signals. Use the strongest signal’s outreach angle in your email.',
  },
  'decision-makers': {
    title: 'Decision Maker Discovery',
    what: 'Finds the right person to contact, from the company’s own website, public pages (news, directories, org charts) and contact databases. Each person is checked against the page and must be tied to this company. Nothing is guessed.',
    next: 'Run it for a company, check the shortlisted person and their email, then start Outreach.',
  },
  outreach: {
    title: 'Outreach',
    what: 'Writes the approved email sequence for the company’s decision maker. You review, edit and approve each email, send it from your own mail program and mark it sent. Follow-ups are due on set days.',
    next: 'Pick a company, click Start outreach, then follow the steps shown at the top.',
  },
  engagement: {
    title: 'Engagement Tracking',
    what: 'Records what the prospect actually did — replies, meetings and other responses — kept separate from what we sent.',
    next: 'Select a company to see its timeline. Record a response when one comes in.',
  },
  crm: {
    title: 'CRM Sync',
    what: 'Prepares a checked handoff package for a qualified company — its details, contacts and evidence — for NXT Sales.',
    next: 'Open a company’s package and review it before it is handed to NXT Sales.',
  },
}
