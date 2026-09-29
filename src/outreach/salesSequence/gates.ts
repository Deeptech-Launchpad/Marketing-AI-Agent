import { inspectSyntax } from '../../emailverification/providers/provider.js'
import { CHANNEL_LIMITS } from '../types.js'
import { EXPO, type StageTemplate } from './templates.js'
import { findUnresolved, tokenOf } from './placeholders.js'
import { senderReady, type SenderConfig } from './sender.js'
import type { StageView } from './stageMachine.js'

// WHAT MUST BE TRUE BEFORE A DRAFT CAN BE APPROVED.
//
// Pure. Each gate is returned as its own checklist item, passed or not, so the
// screen shows Sales exactly what is missing rather than a single "invalid".
// The gates that matter most are the ones the platform cannot answer itself:
// the approved copy states the results of an AI-engine test this platform
// does not run, so a person confirms them — or enters them — before approval.

export interface Attestation {
  key: 'ai_test' | 'report_attached'
  statement: string
  byCrmUserId: string
  at: string // ISO
}

export interface MessageInputs {
  clientCompanyName?: string | null
  skus?: string[] | null
  xOf5?: number | null
  product?: string | null
  productCategory?: string | null
  name?: string | null
}

export interface GateInput {
  template: StageTemplate
  stage: StageView | null
  actionStatus: string
  subject: string | null
  body: string
  inputs: MessageInputs
  attestations: Attestation[]
  /** SKUs from the prospect's confirmed reply (for 2.1). */
  confirmedSkus: string[]
  recipientEmail: string | null
  sender: SenderConfig | null
  suppression: { suppressed: boolean; detail?: string | null } | null
  now: Date
}

export interface GateItem {
  key: string
  ok: boolean
  label: string
  detail: string | null
}

export interface GateResult {
  ok: boolean
  items: GateItem[]
  /** Advisory, never blocking: things Sales should look at. */
  warnings: string[]
}

const DAY_MS = 86_400_000

export function evaluateGates(g: GateInput): GateResult {
  const items: GateItem[] = []
  const warnings: string[] = []
  const push = (key: string, ok: boolean, label: string, detail: string | null = null) => items.push({ key, ok, label, detail })

  // 1. Still a draft, and the stage still applies to this prospect.
  push('draft', g.actionStatus === 'draft', 'The draft is waiting for review', g.actionStatus === 'draft' ? null : `It is "${g.actionStatus}".`)
  const applicable = !g.stage || !['not_applicable', 'skipped', 'done'].includes(g.stage.status)
  push('applicable', applicable, 'This stage still applies to the prospect', applicable ? null : g.stage?.reason ?? null)

  // 2. No placeholder left unfilled.
  const unresolved = [...new Set([...findUnresolved(g.subject), ...findUnresolved(g.body)])]
  push(
    'placeholders',
    unresolved.length === 0,
    'Every placeholder is filled',
    unresolved.length ? `Still unfilled: ${unresolved.map(tokenOf).join(', ')}.` : null,
  )

  // 3. What this stage needs that only Sales can provide.
  for (const def of g.template.attestations) {
    const a = g.attestations.find((x) => x.key === def.key)
    const fresh = a && (def.maxAgeDays === null || g.now.getTime() - new Date(a.at).getTime() <= def.maxAgeDays * DAY_MS)
    push(
      `attest_${def.key}`,
      Boolean(fresh),
      def.key === 'ai_test' ? 'Sales confirmed the AI-engine test result stated in this email' : 'Sales confirmed the report is ready and attached',
      !a
        ? 'Not confirmed yet. The platform does not run this test, so a person must confirm it.'
        : !fresh
          ? `Confirmed ${Math.floor((g.now.getTime() - new Date(a.at).getTime()) / DAY_MS)} days ago; the email says "this week", so confirm it again.`
          : null,
    )
  }
  if (g.template.requiredInputs.includes('clientCompanyName')) {
    const ok = Boolean(g.inputs.clientCompanyName?.trim())
    push('input_client', ok, 'The client company named in the test is entered', ok ? null : 'Enter the company that showed up as the generic buying-group mention.')
  }
  if (g.template.requiredInputs.includes('skus')) {
    const skus = (g.inputs.skus ?? []).filter((s) => s.trim())
    push('input_skus', skus.length === 5, 'Five SKU names are entered', skus.length === 5 ? null : `${skus.length} of 5 entered.`)
  }
  if (g.template.requiredInputs.includes('xOf5')) {
    const x = g.inputs.xOf5
    const ok = typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 5
    push('input_x', ok, 'The report result (X of 5) is entered', ok ? null : 'Enter the number from the report, 0 to 5.')
  }
  if (g.template.needsConfirmedSkus) {
    const ok = g.confirmedSkus.length === 5
    push(
      'confirmed_skus',
      ok,
      'The prospect’s 5 SKUs are confirmed from their reply',
      ok ? null : `This email thanks them for sending 5 SKUs; ${g.confirmedSkus.length} are confirmed.`,
    )
  }

  // 4. Someone to send it to.
  const syntax = g.recipientEmail ? inspectSyntax(g.recipientEmail.trim().toLowerCase()) : null
  push(
    'recipient',
    Boolean(syntax?.valid),
    'A recipient email address is set',
    !g.recipientEmail ? 'No email is stored for this decision maker. Enter the address you will send to.' : syntax?.valid ? null : syntax?.reason ?? null,
  )

  // 5. Someone to send it as.
  push('sender', senderReady(g.sender), 'The sender’s name and company are known', senderReady(g.sender) ? null : 'The email is signed with the name of the person who started this outreach (their NXT Sales login) and the company name an admin sets in Settings → Outreach sender. One of them is missing.')

  // 6. Nobody asked not to be contacted.
  if (g.suppression) {
    push('suppression', !g.suppression.suppressed, 'The company is not suppressed', g.suppression.suppressed ? g.suppression.detail ?? 'Suppressed.' : null)
  }

  // 7. Fits in an email.
  const limits = CHANNEL_LIMITS.email
  const lengthOk = g.body.length <= limits.maxBody && (!g.subject || !limits.maxSubject || g.subject.length <= limits.maxSubject)
  push('length', lengthOk, 'Subject and body are within email length limits', lengthOk ? null : `Body ${g.body.length}/${limits.maxBody} characters.`)
  if (!g.subject?.trim()) push('subject', false, 'The email has a subject', 'Enter a subject.')

  // Advisory only.
  if (g.template.mentionsExpo && g.now.getTime() > new Date(`${EXPO.endsOn}T23:59:59Z`).getTime()) {
    warnings.push(`This email mentions ${EXPO.name} (${EXPO.startsOn}–${EXPO.endsOn}), which has passed. Remove the expo paragraph or keep it deliberately.`)
  }

  return { ok: items.every((i) => i.ok), items, warnings }
}
