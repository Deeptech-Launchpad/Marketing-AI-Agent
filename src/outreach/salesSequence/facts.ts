import { presentSignals } from '../../intent/signalView.js'
import { prisma } from '../../platform/db.js'
import { resolvePipelineCompany } from '../../prospects/discoveredCompanyAdapter.js'

// THE ONLY THINGS A DRAFT MAY SAY ABOUT A PROSPECT.
//
// Every fact here comes from a record another engine already verified, and
// carries an id and its source, so a personalised email can always answer
// "where did that come from": the decision maker Decision Makers shortlisted,
// the product page Prospects actually analysed, the page Enrichment actually
// read, and the intent signals the Intent engine verified (read through
// presentSignals, so status and age are computed now, not frozen at
// detection). Nothing is inferred, and a fact that is absent stays absent.

export interface Fact {
  /** Stable within one draft: "company.name", "signal.<id>", … */
  id: string
  label: string
  value: string
  source: string
  sourceUrl: string | null
}

export interface DecisionMakerFact {
  id: string
  fullName: string
  title: string | null
  email: string | null
  profileUrl: string | null
}

export interface SignalFact {
  id: string
  category: string
  summary: string
  interpretation: string | null
  outreachAngle: string | null
  evidence: string | null
  sourceUrl: string | null
  observedAt: string | null
  confidence: string
}

export interface ProductFact {
  name: string
  url: string | null
  category: string | null
  description: string | null
  gaps: Array<{ title: string; detail: string; severity: string }>
}

export interface ProspectFacts {
  crmCompanyId: string
  discoveredCompanyId: string | null
  companyName: string
  companyDomain: string | null
  companySummary: string | null
  decisionMaker: DecisionMakerFact | null
  product: ProductFact | null
  signals: SignalFact[]
  /** Every fact above, flattened, for personalisation and citation. */
  facts: Fact[]
}

interface StoredProduct {
  name?: string
  url?: string
  category?: string | null
  description?: string | null
}

export async function loadProspectFacts(tenantId: string, crmCompanyId: string): Promise<ProspectFacts | null> {
  const resolved = await resolvePipelineCompany(tenantId, crmCompanyId)
  if (!resolved) return null
  const { company, discoveredCompanyId } = resolved

  const [discovered, enrichment, dmRun, signalRows] = await Promise.all([
    discoveredCompanyId
      ? prisma.discoveredCompany.findFirst({
          where: { id: discoveredCompanyId, tenantId },
          select: { websiteSummary: true, productPageUrl: true, productAnalysis: true },
        })
      : null,
    prisma.companyEnrichment.findFirst({
      where: { tenantId, crmCompanyId, status: 'enriched' },
      orderBy: { createdAt: 'desc' },
      select: { signals: true, sourceUrl: true },
    }),
    prisma.decisionMakerRun.findFirst({
      where: { tenantId, crmCompanyId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    }),
    prisma.intentSignal.findMany({
      where: { tenantId, crmCompanyId },
      orderBy: { detectedAt: 'desc' },
      take: 500,
    }),
  ])

  const candidate = dmRun
    ? await prisma.decisionMakerCandidate.findFirst({
        where: { tenantId, dmRunId: dmRun.id, outcome: 'shortlisted' },
        orderBy: { rank: 'asc' },
        select: { id: true, fullName: true, rawTitle: true, email: true, profileUrl: true },
      })
    : null

  const facts: Fact[] = []
  const add = (f: Fact) => {
    if (f.value.trim()) facts.push({ ...f, value: f.value.trim() })
  }

  add({ id: 'company.name', label: 'Company', value: company.name, source: discoveredCompanyId ? 'Prospects' : 'NXT Sales', sourceUrl: null })
  if (company.domain) add({ id: 'company.domain', label: 'Website', value: company.domain, source: discoveredCompanyId ? 'Prospects' : 'NXT Sales', sourceUrl: null })

  const summary = discovered?.websiteSummary ?? null
  if (summary) add({ id: 'company.summary', label: 'What the company does', value: summary, source: 'Prospects (read from the company’s own website)', sourceUrl: null })

  const enrichSignals = (enrichment?.signals ?? null) as { metaDescription?: string | null; pageTitle?: string | null } | null
  if (enrichSignals?.metaDescription) {
    add({ id: 'company.site_description', label: 'Website description', value: enrichSignals.metaDescription, source: 'Enrichment', sourceUrl: enrichment?.sourceUrl ?? null })
  }

  const decisionMaker: DecisionMakerFact | null = candidate
    ? { id: candidate.id, fullName: candidate.fullName, title: candidate.rawTitle, email: candidate.email, profileUrl: candidate.profileUrl }
    : null
  if (decisionMaker) {
    add({ id: 'dm.name', label: 'Decision maker', value: decisionMaker.fullName, source: 'Decision Makers', sourceUrl: decisionMaker.profileUrl })
    if (decisionMaker.title) add({ id: 'dm.title', label: 'Their role', value: decisionMaker.title, source: 'Decision Makers', sourceUrl: decisionMaker.profileUrl })
  }

  // The one product Prospects actually analysed on the company's own site.
  const analysis = (discovered?.productAnalysis ?? null) as {
    status?: string
    product?: StoredProduct | null
    gaps?: Array<{ title?: string; detail?: string; severity?: string }>
  } | null
  let product: ProductFact | null = null
  if (analysis?.status === 'analysed' && analysis.product?.name) {
    product = {
      name: analysis.product.name,
      url: analysis.product.url ?? discovered?.productPageUrl ?? null,
      category: analysis.product.category ?? null,
      description: analysis.product.description ?? null,
      gaps: (analysis.gaps ?? [])
        .filter((g) => g.title && g.severity !== 'minor')
        .map((g) => ({ title: g.title!, detail: g.detail ?? '', severity: g.severity ?? 'gap' })),
    }
    add({ id: 'product.name', label: 'Product analysed', value: product.name, source: 'Prospects (product page)', sourceUrl: product.url })
    if (product.category) add({ id: 'product.category', label: 'Product category', value: product.category, source: 'Prospects (product page)', sourceUrl: product.url })
    product.gaps.forEach((g, i) =>
      add({ id: `product.gap.${i + 1}`, label: 'Gap on that product page', value: `${g.title}: ${g.detail}`, source: 'Prospects (product page)', sourceUrl: product!.url }),
    )
  }

  const signals: SignalFact[] = presentSignals(signalRows)
    .filter((s) => s.status === 'active')
    .slice(0, 10)
    .map((s) => ({
      id: s.id,
      category: s.signalCategory,
      summary: s.summary,
      interpretation: s.interpretation ?? null,
      outreachAngle: s.outreachAngle ?? null,
      evidence: s.evidence ?? null,
      sourceUrl: s.sourceUrl ?? null,
      observedAt: s.observedAt ? new Date(s.observedAt).toISOString().slice(0, 10) : null,
      confidence: s.confidence,
    }))
  for (const s of signals) {
    add({ id: `signal.${s.id}`, label: `Intent signal (${s.category})`, value: s.summary, source: 'Intent Signals', sourceUrl: s.sourceUrl })
  }

  return {
    crmCompanyId,
    discoveredCompanyId,
    companyName: company.name,
    companyDomain: company.domain,
    companySummary: summary,
    decisionMaker,
    product,
    signals,
    facts,
  }
}
