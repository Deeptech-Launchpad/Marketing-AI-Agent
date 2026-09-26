import type {
  EmbedOptions,
  EmbedResult,
  GenerateOptions,
  LlmPort,
  LlmResult,
  WebSearchOptions,
  WebSearchResult,
} from '../llmPort.js'

// Deterministic LLM. Every orchestration path can be exercised in CI with no
// API key, no cost and no flakiness.
//
// The canned payloads are still validated against the real zod schema by the
// caller, so if a step's schema changes and this fixture is not updated, the
// test fails — which is the point. This is a fixture, not a bypass.

const CANNED: Record<string, unknown> = {
  'intake.parse_objective': {
    intent: 'lead_generation',
    // Added to match IntakeOutput, which gained `targetConcept` after this
    // fixture was written. The FakeLlm validates against the caller's real
    // schema precisely so this drift fails loudly — it did, and this is the
    // repair. The value matches the sibling `prospect.parse_objective`
    // fixture, which parses the same objective.
    targetConcept: 'infrastructure',
    verticalHint: 'infrastructure',
    geoHint: null,
    volumeHint: null,
    channelHint: null,
    ambiguities: ['geography unspecified', 'company size unspecified'],
  },

  'prospect.parse_objective': {
    targetConcept: 'infrastructure',
    geography: [],
    requestedCount: null,
    statedNeedHypothesis: null,
    companyCharacteristics: [],
    includeExistingOpportunities: false,
    ambiguities: ['geography unspecified', 'company size unspecified'],
  },

  // Deliberately an AMBIGUOUS mapping (empty `direct`): that is what the real
  // model returns for "infrastructure" against the real CRM vocabulary, and the
  // fake should exercise the same branch rather than the easy one.
  'segment.map_concept': {
    direct: [],
    related: [
      { value: 'Infrastructure & Construction', reason: 'Builds and maintains physical infrastructure.' },
      { value: 'Industrial Equipment', reason: 'Supplies plant used on infrastructure projects.' },
    ],
    interpretation: 'Physical built-environment supply; no single exact category exists.',
  },

  'icp.synthesize': {
    name: 'Infrastructure & industrial distributors',
    definition: {
      industries: ['Infrastructure & Construction', 'Industrial Equipment'],
      countries: ['United States', 'United Kingdom'],
      cmsValues: ['Magento'],
      signals: ['deep technical catalog', 'incomplete specification data'],
    },
    reasoning: 'Won deals concentrate in infrastructure-adjacent verticals on Magento storefronts.',
    confidence: 'medium',
  },

  'segment.propose': {
    industries: ['Infrastructure & Construction', 'Industrial Equipment'],
    countries: ['United States', 'United Kingdom'],
    cmsValues: [],
    leadStatuses: [],
    hasDeal: false,
    rationale: 'Targets the two verticals with the strongest won-deal concentration, excluding existing deals.',
  },

  'research.synthesize': {
    summary: 'Industrial distributors publish thin product data; specification depth is the common gap.',
    findings: [
      { claim: 'Catalog pages routinely omit compliance and dimensional data.', source: 'page' },
      { claim: 'Magento storefronts dominate this vertical.', source: 'page' },
    ],
    competitorNotes: [],
  },

  'strategy.generate': {
    channelMix: [
      { channel: 'linkedin', rationale: 'Decision makers are reachable by role targeting.', weight: 0.5 },
      { channel: 'email', rationale: 'Direct follow-up to owned CRM contacts.', weight: 0.5 },
    ],
    messagingPillars: [
      { name: 'Specification completeness', angle: 'Buyers abandon technical purchases when specs are missing.' },
      { name: 'Time to publish', angle: 'New SKUs reach the storefront faster with structured enrichment.' },
    ],
    sequence: [
      { step: 1, channel: 'linkedin', description: 'Awareness post on catalog data gaps.' },
      { step: 2, channel: 'email', description: 'Personalised outreach referencing the prospect PDP.' },
    ],
    kpis: [
      { name: 'Qualified leads', target: '25 per month' },
      { name: 'Cost per lead', target: 'under USD 120' },
    ],
    rationale: 'Concentrates spend on the vertical with the highest observed win rate.',
  },

  'content.generate': {
    assets: [
      {
        channel: 'linkedin',
        assetType: 'post',
        name: 'Catalog gaps awareness post',
        variants: [
          {
            label: 'A',
            headline: 'Your best-selling SKU is missing half its specifications',
            body: 'Industrial buyers do not call to ask for dimensions. They leave. Complete, structured product data is the difference between a quote request and a bounce.',
            callToAction: 'See what a complete PDP looks like',
          },
        ],
      },
      {
        channel: 'email',
        assetType: 'email_body',
        name: 'Specification gap outreach',
        variants: [
          {
            label: 'A',
            headline: 'Specification coverage on your catalog',
            body: 'We reviewed a sample of your product pages and found consistent gaps in dimensional and compliance data. Enriching those attributes typically lifts conversion on technical SKUs.',
            callToAction: 'Book a 15-minute catalog review',
          },
        ],
      },
    ],
  },

  'content.validate': {
    passed: true,
    issues: [],
  },

  // Deterministic PDP enrichment for tests. Generic on purpose: no company or
  // product is named, so it fits any fixture page. The service's own checks
  // then decide each attribute's real source.
  'pdp.enrich': {
    enrichedTitle: 'Standard Industrial Product, Model A, Grey',
    brand: null,
    series: null,
    manufacturerPartNumber: null,
    productType: 'Industrial Product',
    categoryPath: ['Industrial Supplies', 'General Products', 'Standard Products'],
    industryLabel: 'Industrial & Commercial Supplies',
    unspsc: null,
    description: {
      intro: 'A general-purpose industrial product designed for everyday professional use in commercial settings.',
      bullets: ['Durable construction for daily use', 'Suitable for commercial environments', 'Easy to install and maintain'],
    },
    attributes: [
      { name: 'Product Type', value: 'Industrial Product', source: 'enriched', sourceRef: null },
      { name: 'Material', value: 'Stainless Steel', source: 'enriched', sourceRef: null },
      { name: 'Colour', value: 'Grey', source: 'enriched', sourceRef: null },
      { name: 'Finish', value: 'Brushed', source: 'enriched', sourceRef: null },
      { name: 'Width', value: '300 mm', source: 'enriched', sourceRef: null },
      { name: 'Height', value: '200 mm', source: 'enriched', sourceRef: null },
      { name: 'Weight', value: '2.4 kg', source: 'enriched', sourceRef: null },
      { name: 'Pack Quantity', value: '1 Piece', source: 'enriched', sourceRef: null },
      { name: 'Price', value: '99.00', source: 'enriched', sourceRef: null },
    ],
    recommendedDocuments: ['Technical Data Sheet', 'Declaration of Conformity'],
    attributeHighlights: [
      { heading: 'Physical Specification', detail: 'Material, finish, width, height and weight stated as separate values with units.' },
      { heading: 'Identification', detail: 'Product type and pack quantity mapped to discrete attributes.' },
      { heading: 'Documentation', detail: 'Technical data sheet and declaration of conformity associated with the record.' },
    ],
    beforeNarrative: ['The original listing publishes the product name and little else; structured specifications are absent.'],
    afterNarrative: ['The enriched record surfaces structured attributes in a technical specification matrix with tabbed documentation.'],
    keyTransformation: 'The listing evolves from a basic catalogue entry into a structured, filterable product master record.',
    introParagraph: 'This report presents an objective Before & After audit of a single product detail page, showing how a sparse listing becomes an attribute-rich product record.',
    executiveSummary: 'Professional buyers need structured specifications before purchase. Converting a basic page into a technical record reduces pre-sales questions.',
    normalizationNotes: [
      { heading: 'Unit Normalisation', detail: 'Dimensions and weights are stated in metric units as separate attributes.' },
      { heading: 'Parameter Disaggregation', detail: 'Combined description text is split into discrete, filterable properties.' },
    ],
    auditSummary: 'This single-product comparison shows how a sparse listing can be converted into a structured technical record.',
    keyImprovements: [
      { heading: 'Structured Specification Data', detail: 'Attributes exposed in a technical specification matrix.' },
      { heading: 'Standardised Naming', detail: 'Product titles follow a consistent naming convention.' },
      { heading: 'Faceted-Filtering Readiness', detail: 'Key attributes indexed for category filters.' },
    ],
    nextSteps: [
      { heading: 'Catalog Data Health Audit', detail: 'Benchmark attribute completeness across existing SKUs.' },
      { heading: 'Taxonomy Mapping', detail: 'Map legacy categories to a standard B2B classification.' },
      { heading: 'Pilot Batch', detail: 'Enrich a pilot batch of products to validate the approach.' },
    ],
  },

  // Deterministic assistant answer for tests: a grounded reply, one draft that
  // uses a bracketed placeholder, and no proposed edit.
  'report.assistant': {
    reply: 'The audit found that the hero product page does not publish a manufacturer part number or a GTIN.',
    drafts: [
      {
        kind: 'spec_table',
        title: 'Specification table',
        content: 'Manufacturer part number: [Manufacturer part number] (example)\nGTIN: [13-digit GTIN / EAN barcode] (example)',
      },
    ],
    proposedEdit: null,
    citations: ['A4'],
  },
}

export class FakeLlm implements LlmPort {
  readonly name = 'fake'

  async generate<T>(opts: GenerateOptions<T>): Promise<LlmResult<T>> {
    const canned = CANNED[opts.promptKey]
    if (canned === undefined) {
      throw new Error(`FakeLlm has no canned response for prompt key "${opts.promptKey}".`)
    }

    // Validate against the caller's real schema so fixture drift fails loudly
    // instead of producing a run that only passes because nothing checked it.
    const data = opts.schema ? opts.schema.parse(canned) : (String(canned) as unknown as T)

    return {
      data: data as T,
      text: JSON.stringify(canned),
      usage: { promptTokens: 100, outputTokens: 200, totalTokens: 300, hasUsageData: true },
      model: 'fake-model',
      modelRequested: 'fake-model',
      fellBack: false,
      costUsd: 0,
      priced: false,
      latencyMs: 1,
    }
  }

  /** Deterministic pseudo-vectors: same text always yields the same vector. */
  async embed(opts: EmbedOptions): Promise<EmbedResult> {
    const vectors = opts.texts.map((text) => {
      let seed = 0
      for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) % 2_147_483_647
      const v = new Array<number>(768)
      for (let i = 0; i < 768; i++) {
        seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_647
        v[i] = (seed % 2000) / 1000 - 1
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1
      return v.map((x) => x / norm)
    })
    return {
      vectors,
      model: 'fake-embedding',
      usage: { promptTokens: 0, outputTokens: 0, totalTokens: 0, hasUsageData: false },
    }
  }

  /**
   * The fake driver has no search capability, and says so.
   *
   * Returning an empty success would be worse than useless: the public
   * research layer distinguishes "searched, found nothing" from "cannot
   * search", and a fake that blurred the two would let a test pass on a
   * behaviour the real driver does not have.
   */
  async searchWeb(_opts: WebSearchOptions): Promise<WebSearchResult> {
    return {
      ok: false,
      provider: this.name,
      queriesRun: [],
      references: [],
      modelText: '',
      model: null,
      costUsd: 0,
      reason: 'LLM_DRIVER=fake has no web search capability, so no public research was attempted.',
    }
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}
