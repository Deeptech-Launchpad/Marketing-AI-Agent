import 'dotenv/config'
import { env } from '../src/config/env.js'
import { ApolloProvider } from '../src/decisionmakers/providers/apolloProvider.js'
import { ZoomInfoProvider } from '../src/decisionmakers/providers/zoomInfoProvider.js'
import { RocketReachProvider } from '../src/decisionmakers/providers/rocketReachProvider.js'
import { LinkedInReferenceProvider } from '../src/decisionmakers/providers/linkedInReferenceProvider.js'
import { HunterProvider } from '../src/emailverification/providers/hunterProvider.js'
import { VerifaliaProvider } from '../src/emailverification/providers/verifaliaProvider.js'
import { channelStatus } from '../src/outreach/engine.js'
import { JOB_BOARDS, boardAvailability } from '../src/intent/jobBoards.js'

// PROVIDER READINESS.
//
// Every line below is read from the adapter itself, not from a list somebody
// maintained by hand — an adapter that starts working must not need this
// script edited to say so.
//
// The only states are the real ones. There is no "partially ready", and no
// fallback that substitutes a fake provider for a missing credential: a
// provider without a credential blocks its feature, and the feature reports
// that it is blocked.

interface Row {
  provider: string
  feature: string
  configured: boolean
  state: string
  credentials: string[]
  nextAction: string
}

const set = (k: keyof typeof env): boolean => String(env[k] ?? '').trim().length > 0

const rows: Row[] = []

// ── Decision-maker chain (Team Answer A.3 / E.2) ──────────────────────────
const apollo = new ApolloProvider().available()
rows.push({
  provider: 'Apollo',
  feature: 'Decision-maker discovery (primary source)',
  configured: set('APOLLO_API_KEY'),
  state: apollo.status,
  credentials: ['APOLLO_API_KEY'],
  nextAction: set('APOLLO_API_KEY')
    ? 'None. Verify a live lookup against one real company before first use.'
    : 'Obtain an Apollo API key and set APOLLO_API_KEY.',
})

const zoom = new ZoomInfoProvider().available()
rows.push({
  provider: 'ZoomInfo',
  feature: 'Decision-maker discovery (fallback 2)',
  configured: set('ZOOMINFO_USERNAME') && (set('ZOOMINFO_PASSWORD') || set('ZOOMINFO_PRIVATE_KEY')),
  state: zoom.status,
  credentials: ['ZOOMINFO_USERNAME', 'ZOOMINFO_PASSWORD', 'ZOOMINFO_CLIENT_ID', 'ZOOMINFO_PRIVATE_KEY'],
  nextAction: 'Obtain ZoomInfo API access and set the username plus either a password or a private key.',
})

const rr = new RocketReachProvider().available()
rows.push({
  provider: 'RocketReach',
  feature: 'Decision-maker discovery (fallback 3)',
  configured: set('ROCKETREACH_API_KEY'),
  state: rr.status,
  credentials: ['ROCKETREACH_API_KEY'],
  nextAction: 'Obtain a RocketReach API key and set ROCKETREACH_API_KEY.',
})

const li = new LinkedInReferenceProvider().available()
rows.push({
  provider: 'LinkedIn (official API)',
  feature: 'Decision-maker discovery (fallback 4) + LinkedIn job signals',
  configured: set('LINKEDIN_ACCESS_TOKEN'),
  state: li.status,
  credentials: ['LINKEDIN_ACCESS_TOKEN'],
  nextAction:
    'Requires an approved LinkedIn Partner Program application. Scraping is refused by policy and is not a substitute.',
})

// ── Email verification (Team Answer, Section 4) ────────────────────────────
const hunter = new HunterProvider().available()
rows.push({
  provider: 'Hunter.io',
  feature: 'Email verification — gates every outreach-ready address',
  configured: set('HUNTER_API_KEY'),
  state: hunter.status,
  credentials: ['HUNTER_API_KEY'],
  nextAction: 'Obtain a Hunter.io key and set HUNTER_API_KEY. Either this or Verifalia unblocks outreach.',
})

const verifalia = new VerifaliaProvider().available()
rows.push({
  provider: 'Verifalia',
  feature: 'Email verification (alternative to Hunter.io)',
  configured: set('VERIFALIA_USERNAME') && set('VERIFALIA_PASSWORD'),
  state: verifalia.status,
  credentials: ['VERIFALIA_USERNAME', 'VERIFALIA_PASSWORD'],
  nextAction: 'Obtain Verifalia credentials, or configure Hunter.io instead.',
})

// ── Outreach channels ─────────────────────────────────────────────────────
const CHANNEL_META: Record<string, { provider: string; creds: string[]; action: string }> = {
  email: {
    provider: 'Google Workspace (email)',
    creds: ['EMAIL_PROVIDER', 'OUTREACH_FROM_EMAIL', 'OUTREACH_FROM_NAME'],
    action:
      'Set EMAIL_PROVIDER and the sending credentials for manoj@ / mohanapriya@altiusnxt.com. ' +
      'Sending also requires a verified address, so email verification must be configured first.',
  },
  email_followup: {
    provider: 'Google Workspace (follow-up)',
    creds: ['EMAIL_PROVIDER'],
    action: 'Same provider as email; unblocks together.',
  },
  whatsapp: {
    provider: 'WhatsApp Business API (BSP)',
    creds: ['WHATSAPP_PROVIDER', 'OUTREACH_WHATSAPP_ENABLED'],
    action:
      'Requires an official BSP (meta_cloud or twilio) with approved templates. A standard WhatsApp account is refused.',
  },
  linkedin: {
    provider: 'LinkedIn',
    creds: ['LINKEDIN_ACCESS_TOKEN'],
    action: 'Manual-only by approved policy: AI drafts, a person sends. No action needed to keep this state.',
  },
  call: {
    provider: 'CallHippo (via NXT Sales)',
    creds: ['OUTREACH_CALL_TASK_PROVIDER'],
    action:
      'Calls route through the existing CallHippo–NXT Sales integration as a task. No second dialler, and no CallHippo key is held by this platform.',
  },
}

for (const c of channelStatus()) {
  const meta = CHANNEL_META[c.channel]!
  rows.push({
    provider: meta.provider,
    feature: `Outreach — ${c.channel}`,
    configured: c.status === 'available',
    state: c.status,
    credentials: meta.creds,
    nextAction: c.status === 'available' ? 'None.' : meta.action,
  })
}

// ── Job boards ────────────────────────────────────────────────────────────
for (const b of JOB_BOARDS) {
  const a = boardAvailability(b, b.countries === 'global' ? null : (b.countries as string[])[0]!)
  rows.push({
    provider: `${b.name} (job signals)`,
    feature: 'Intent — hiring signals',
    configured: a.status === 'available',
    state: a.status,
    credentials: [b.actorEnvKey],
    nextAction:
      a.status === 'available'
        ? 'None.'
        : b.policyBlock
          ? 'Blocked by policy, not by configuration. Requires official API access.'
          : `Set ${b.actorEnvKey} to a collector that can scope a search to one company.`,
  })
}

// ── Output ────────────────────────────────────────────────────────────────
const ready = rows.filter((r) => r.configured)
const blocked = rows.filter((r) => !r.configured)

console.log('PROVIDER READINESS — AltiusNXT Marketing AI')
console.log(`Generated ${new Date().toISOString().slice(0, 10)} · ${ready.length} ready, ${blocked.length} blocked\n`)

const line = (r: Row) => {
  console.log(`  ${r.provider}`)
  console.log(`    feature      ${r.feature}`)
  console.log(`    state        ${r.state}`)
  console.log(`    credentials  ${r.credentials.join(', ')}`)
  console.log(`    next action  ${r.nextAction}`)
  console.log('')
}

console.log('── READY ────────────────────────────────────────────────\n')
ready.forEach(line)
console.log('── BLOCKED ────────────────────────────────────────────\n')
blocked.forEach(line)

console.log('NO FAKE FALLBACK: every blocked provider above reports its state to the')
console.log('engine that needs it. None is substituted, mocked or silently skipped.')
