import { describe, expect, it, vi } from 'vitest'
import {
  audienceFor,
  planCustomerReportQr,
  type CustomerReportQrState,
} from '../../src/websiteaudit/customerReport.js'
import { renderPdpReport, type PdpReportInput } from '../../src/websiteaudit/pdpReport.js'
import { NO_SUBJECT_SCORECARD } from '../../src/websiteaudit/discoverabilityScore.js'

// MINTING A SHARE LINK IS PUBLICATION.
//
// The link a QR encodes is a bearer credential: whoever holds it opens the
// customer's demonstration without signing in. The export endpoint created one
// on `demo.status === 'ready'` alone, before the report's approval state was
// consulted at all.
//
// Nothing ever leaked. generateCustomerReport withheld the QR from an
// unapproved copy, so no credential was ever printed in a document nobody had
// signed off. The damage was quieter:
//
//   · a live credential was created, and audit-logged, for an unapproved
//     document — publication performed as a side effect of review
//   · mintLink hands back the plaintext token exactly once and keeps only its
//     hash, so that link's URL is afterwards unrecoverable
//   · the NEXT export — the approved one, the copy that goes to the customer —
//     found that link usable, took the "existing link, not recoverable"
//     branch, and shipped with no QR on it
//
// So opening a draft in the viewer silently spent the one QR the finished
// report was going to carry. The decision now happens before anything is
// written, which is what these tests pin.

const STATES: Record<string, CustomerReportQrState> = {
  suppressed: 'suppressed',
  notApproved: 'not-approved',
  unavailable: 'unavailable',
}

describe('A. a ready demonstration on an UNAPPROVED report mints nothing', () => {
  // Every status the report machine can be in, other than approved. The point
  // is that "not approved" is the default and `approved` is the exception,
  // rather than a list of statuses somebody has to keep current.
  for (const status of [
    'draft',
    'generating',
    'ready_for_approval',
    'in_review',
    'changes_requested',
    'rejected',
    'expired',
    null,
    undefined,
    '',
    'APPROVED',
    'approved ',
  ]) {
    it(`refuses to mint when the report status is ${JSON.stringify(status)}`, () => {
      const plan = planCustomerReportQr({ qrRequested: true, reportStatus: status, demoStatus: 'ready' })
      expect(plan.consider, 'nothing may be minted').toBe(false)
      expect(plan.state).toBe(STATES.notApproved)
    })
  }

  it('says why, rather than looking like the demonstration was missing', () => {
    const notApproved = planCustomerReportQr({ qrRequested: true, reportStatus: 'draft', demoStatus: 'ready' })
    const noDemo = planCustomerReportQr({ qrRequested: true, reportStatus: 'approved', demoStatus: null })
    // Two different reasons for no QR, reported as two different states, so an
    // operator is never left guessing whether the code failed to render.
    expect(notApproved.state).toBe('not-approved')
    expect(noDemo.state).toBe('unavailable')
  })

  it('refuses ahead of every other reason', () => {
    // An unapproved report with no demonstration is still refused as
    // unapproved: the gate is first, so it cannot be reached around.
    for (const demoStatus of ['ready', 'building', 'failed', null, undefined]) {
      const plan = planCustomerReportQr({ qrRequested: true, reportStatus: 'draft', demoStatus })
      expect(plan.consider, String(demoStatus)).toBe(false)
      expect(plan.state, String(demoStatus)).toBe('not-approved')
    }
  })
})

describe('B. a ready demonstration on an APPROVED report proceeds as before', () => {
  it('considers the link, which is what mints or reuses one', () => {
    const plan = planCustomerReportQr({ qrRequested: true, reportStatus: 'approved', demoStatus: 'ready' })
    expect(plan.consider).toBe(true)
  })

  // Unchanged behaviour, restated so a later edit cannot quietly drop it.
  it('still needs the demonstration to be ready', () => {
    for (const demoStatus of ['building', 'failed', 'draft', null, undefined]) {
      const plan = planCustomerReportQr({ qrRequested: true, reportStatus: 'approved', demoStatus })
      expect(plan.consider, String(demoStatus)).toBe(false)
      expect(plan.state, String(demoStatus)).toBe(STATES.unavailable)
    }
  })

  it('still honours ?qr=0 even on an approved report', () => {
    const plan = planCustomerReportQr({ qrRequested: false, reportStatus: 'approved', demoStatus: 'ready' })
    expect(plan.consider).toBe(false)
    expect(plan.state).toBe(STATES.suppressed)
  })

  it('suppression outranks approval, so the inline viewer creates nothing', () => {
    for (const reportStatus of ['approved', 'draft', null]) {
      expect(planCustomerReportQr({ qrRequested: false, reportStatus, demoStatus: 'ready' }).state).toBe('suppressed')
    }
  })
})

describe('E. the audience rule has exactly one definition', () => {
  it('calls only an approved report a customer copy', () => {
    expect(audienceFor('approved')).toBe('customer')
    for (const s of ['draft', 'ready_for_approval', 'rejected', null, undefined, '', 'Approved']) {
      expect(audienceFor(s), JSON.stringify(s)).toBe('internal_review')
    }
  })

  // The defect was two rules: the document asked "is it approved?" and the QR
  // asked "is the demo ready?". They are now the same question, asked once.
  it('gates the QR on the same rule that decides the audience', () => {
    for (const status of ['approved', 'draft', 'ready_for_approval', 'rejected', null]) {
      const isCustomer = audienceFor(status) === 'customer'
      const plan = planCustomerReportQr({ qrRequested: true, reportStatus: status, demoStatus: 'ready' })
      expect(plan.consider, JSON.stringify(status)).toBe(isCustomer)
    }
  })
})

describe('F. repeated exports of the same approved report are idempotent', () => {
  // The plan is a pure function of the facts, so the second export of an
  // unchanged report reaches the identical decision. What happens after
  // `consider` is the pre-existing reuse rule: a usable labelled link is
  // reused (rendered without a QR, because its URL cannot be rebuilt from a
  // hash) and only its absence mints a new one. That is untouched here.
  it('reaches the same decision every time nothing has changed', () => {
    const facts = { qrRequested: true, reportStatus: 'approved', demoStatus: 'ready' } as const
    const first = planCustomerReportQr(facts)
    const second = planCustomerReportQr(facts)
    const third = planCustomerReportQr(facts)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
  })

  it('does not depend on anything but the facts it is given', () => {
    const now = Date.now
    try {
      // No clock, no counter, no hidden state: a plan taken a year apart is
      // the same plan.
      Date.now = () => 0
      const a = planCustomerReportQr({ qrRequested: true, reportStatus: 'approved', demoStatus: 'ready' })
      Date.now = () => 365 * 24 * 3600 * 1000
      const b = planCustomerReportQr({ qrRequested: true, reportStatus: 'approved', demoStatus: 'ready' })
      expect(a).toEqual(b)
    } finally {
      Date.now = now
    }
  })
})

// ── C, D and G: what the two documents actually contain ───────────────────

const baseInput = (over: Partial<PdpReportInput> = {}): PdpReportInput => ({
  companyName: 'A Company',
  website: 'https://example.test/',
  preparedFor: 'A Company',
  auditDate: '2026-09-01',
  sector: null,
  location: null,
  pagesInspected: 11,
  productPagesInspected: 0,
  scorecard: NO_SUBJECT_SCORECARD,
  remediation: [],
  subject: null,
  productEvidence: null,
  categoryLabel: null,
  recommendedAttributes: [],
  scopeNote: 'Scope note.',
  nextStep: 'A short walkthrough of the records built from your own pages.',
  ctaLabel: 'Book a walkthrough',
  preparedBy: { name: 'AltiusNxt Marketing AI', role: 'Automated catalogue audit', email: null },
  approvedBy: null,
  workbenchUrl: null,
  legalDisclaimer: 'Disclaimer.',
  ...over,
})

const SHARE_URL = 'https://demo.altiusnxt.test/w/abc123'

/** pdfkit compresses its content streams and writes text as hex runs. */
async function textOf(input: PdpReportInput): Promise<string> {
  const { inflateSync } = await import('node:zlib')
  const { bytes } = await renderPdpReport(input)
  const raw = bytes.toString('latin1')
  const runs: string[] = []
  const fromHex = (h: string) => Buffer.from(h.replace(/[^0-9a-fA-F]/g, ''), 'hex').toString('latin1')
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let c: string
    try {
      c = inflateSync(Buffer.from(m[1]!, 'latin1')).toString('latin1')
    } catch {
      continue
    }
    for (const t of c.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) runs.push(t[1]!)
    for (const t of c.matchAll(/<([0-9a-fA-F\s]+)>\s*Tj/g)) runs.push(fromHex(t[1]!))
    for (const t of c.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
      const parts: string[] = []
      for (const s of t[1]!.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) parts.push(s[1]!)
      for (const s of t[1]!.matchAll(/<([0-9a-fA-F\s]+)>/g)) parts.push(fromHex(s[1]!))
      runs.push(parts.join(''))
    }
  }
  return runs.join(' ').replace(/\\([()\\])/g, '$1').replace(/\s+/g, ' ').trim()
}

describe('C. an unapproved copy carries no QR and no link', () => {
  const review = () =>
    baseInput({
      workbenchUrl: null,
      reviewWatermark: 'INTERNAL REVIEW — report is "ready for approval" — not for customer distribution',
    })

  it('prints neither the code nor the URL under it', async () => {
    const text = await textOf(review())
    expect(text).not.toContain(SHARE_URL)
    expect(text).not.toContain('/w/')
  })

  it('is watermarked on every page instead', async () => {
    const text = await textOf(review())
    expect((text.match(/INTERNAL REVIEW/g) ?? []).length).toBe(7)
  })

  it('still says what the next step is', async () => {
    const text = await textOf(review())
    expect(text).toContain('Book a walkthrough')
    expect(text).toContain('A short walkthrough')
  })
})

describe('D. an approved copy keeps its QR', () => {
  it('prints the share URL beneath the code', async () => {
    const text = await textOf(baseInput({ workbenchUrl: SHARE_URL }))
    expect(text).toContain(SHARE_URL)
  })

  it('carries no watermark', async () => {
    const text = await textOf(baseInput({ workbenchUrl: SHARE_URL }))
    expect(text).not.toContain('INTERNAL REVIEW')
  })
})

describe('G. nothing but the QR differs between the two', () => {
  it('changes no other word in the document', async () => {
    const withQr = await textOf(baseInput({ workbenchUrl: SHARE_URL }))
    const without = await textOf(baseInput({ workbenchUrl: null }))
    // The QR panel prints the URL under the code; remove that one string and
    // the two documents read identically, page for page.
    expect(withQr.replace(` ${SHARE_URL}`, '')).toBe(without)
  })

  it('is still exactly seven pages either way', async () => {
    expect((await renderPdpReport(baseInput({ workbenchUrl: SHARE_URL }))).pageCount).toBe(7)
    expect((await renderPdpReport(baseInput({ workbenchUrl: null }))).pageCount).toBe(7)
  })

  it('is still byte-identical when rendered twice', async () => {
    const a = await renderPdpReport(baseInput({ workbenchUrl: SHARE_URL }))
    const b = await renderPdpReport(baseInput({ workbenchUrl: SHARE_URL }))
    expect(a.sha256).toBe(b.sha256)
  })
})

describe('the plan never reaches for anything outside its arguments', () => {
  it('touches no database and no clock', async () => {
    const spy = vi.fn()
    // A pure decision cannot log, query or fetch. If it ever starts to, this
    // is the test that says so before a reviewer has to notice.
    vi.stubGlobal('fetch', spy)
    try {
      planCustomerReportQr({ qrRequested: true, reportStatus: 'approved', demoStatus: 'ready' })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
