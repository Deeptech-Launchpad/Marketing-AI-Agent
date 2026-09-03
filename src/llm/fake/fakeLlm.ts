import type { EmbedOptions, EmbedResult, GenerateOptions, LlmPort, LlmResult } from '../llmPort.js'

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

  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
}
