// ─────────────────────────────────────────────────────────────────────────
// Contracts, mirrored from the marketing-agent routes.
//
// Every field here exists on a real response. Where the backend can return
// null it is typed null, so a screen has to decide what to show rather than
// rendering "undefined" — that is how honest empty states stay honest.
// ─────────────────────────────────────────────────────────────────────────

export type Permission = 'view' | 'operate' | 'approve' | 'admin'
export type MemberRole = 'viewer' | 'operator' | 'approver' | 'admin'

export interface Principal {
  crmUserId: string
  email: string
  name: string
  tenantId: string
  role: MemberRole
  permissions: Permission[]
}

/** The status vocabulary the whole interface renders. */
export type UiStatus = 'ready' | 'running' | 'complete' | 'blocked' | 'review' | 'error' | 'idle'

// ── Prospect discovery (#977) ───────────────────────────────────────────
export interface ProspectSearch {
  id: string
  objective: string
  status: string
  totalMatched: number
  totalReturned: number
  mappingStatus: string | null
  requiresApproval: boolean
  createdAt: string
  finishedAt: string | null
}

// ── Open-web company discovery — Stage 1b (2026-09-24 restructure) ──────
//
// Additive to Prospect Discovery, which stays CRM-only. "Find New Company"
// searches the public web via Gemini and verifies each candidate by fetching
// its own site — never invented, never taken from the model's prose.
export interface CompanyDiscoverySearch {
  id: string
  objective: string
  requestedCount: number | null
  status: string
  totalCandidatesFound: number
  totalAssessed: number
  failureReason: string | null
  createdAt: string
  finishedAt: string | null
}

export interface DiscoveredCompanyFit {
  verdict: 'likely_fit' | 'possible_fit' | 'unlikely_fit'
  reasons: string[]
}

export interface DiscoveredCompany {
  id: string
  companyName: string
  domain: string | null
  websiteUrl: string | null
  websiteSummary: string | null
  fitAssessment: DiscoveredCompanyFit | null
  discoverySourceUrl: string
  discoverySourceTitle: string | null
  /** One product page on the company's own website, audited. Null on searches from before 2026-09-25. */
  productPageUrl?: string | null
  productAnalysis?: ProductPageAnalysis | null
  serviceNeed?: ServiceNeed | null
  status: string
  crmCompanyId: string | null
  createdAt: string
}

/** Whether a discovered company needs the service, from its own product page. */
export type ServiceNeed = 'needed' | 'possible' | 'not_needed' | 'not_assessed'

/** Mirrors src/prospects/productPageAnalysis.ts. */
/**
 * A verified shared company mailbox, used only when the decision maker has no
 * email of their own. Mirrors src/decisionmakers/companyContactEmail.ts.
 */
export interface CompanyContactEmail {
  email: string
  mailbox: string
  source: 'company_website' | 'hunter_public_page' | 'crm_record'
  sourceLabel: string
  sourceUrl: string | null
  evidence: string
  checkedAt: string
}

/** Where a company is, as its own website or the listing that named it states. Mirrors src/prospects/companyLocation.ts. */
export interface CompanyLocation {
  text: string
  city: string | null
  region: string | null
  postalCode: string | null
  country: string | null
  source: string
  sourceUrl: string
}

/** What a buyer sees on the product page, read verbatim. Mirrors src/prospects/productPageDetails.ts. */
export interface ProductPageDetails {
  title: string | null
  images: string[]
  identifiers: Array<{ label: string; value: string }>
  price: { amount: string; currency: string | null; label: string | null; source: 'structured data' | 'page text' } | null
  priceNote: string | null
  availability: string | null
  ordering: Array<{ label: string; value: string }>
  buyingOptions: string[]
  downloads: Array<{ label: string; url: string; fileType: string | null }>
}

export interface ProductPageAnalysis {
  status:
    | 'analysed'
    | 'source_unreadable'
    | 'not_relevant'
    | 'no_website'
    | 'duplicate'
    | 'website_unreachable'
    | 'no_product_page'
    | 'blocked'
    | 'browser_only'
    | 'time_budget'
  statusReason: string
  websiteUrl: string | null
  /** A product page that exists but could not be read, for Sales to open. */
  reviewUrl?: string | null
  pagesChecked: Array<{ url: string; outcome: string }>
  product: {
    name: string
    url: string
    description: string | null
    imageUrl: string | null
    brand: string | null
    sku: string | null
    category: string | null
    price: string | null
    attributes: Array<{ name: string; value: string; source: string }>
    featureBullets?: string[]
    readBy?: string
    /** The page as a buyer sees it. Absent on products analysed before 2026-09-26. */
    page?: ProductPageDetails
    structure: {
      structuredData: string[]
      fieldsPublished: number
      fieldsTotal: number
      specificationRows: number
      wordCount: number
      descriptionSentences?: number
      fields: Array<{ label: string; state: 'observed' | 'restructured' | 'absent' }>
    }
  } | null
  /** Only on rows written before 2026-09-25's one-product change. */
  audit?: {
    score: number
    verdict: string
    denominatorNote: string
    assessedCount: number
    checks: Array<{ ref: string; metric: string; status: string; finding: string }>
  } | null
  /** What is missing or problematic in the product's information. Absent on older rows. */
  gaps?: Array<{ key: string; severity: 'major' | 'gap' | 'minor'; title: string; detail: string }>
  issues: string[]
  missingInformation: Array<{ label: string; recommendation: string }>
  recommendedActions: Array<{ title: string; remediation: string; impact: string; effort: string }>
  serviceNeed: ServiceNeed
  whyNeeded: string | null
  nextStep: string | null
  /** Absent on searches before 2026-09-26, and when no page stated an address. */
  companyLocation?: CompanyLocation | null
}

// ── Enrichment (#977)───────────────────────────────────────────────────
export interface EnrichmentRow {
  id: string
  crmCompanyId: string
  companyName: string | null
  status: string
  sourceUrl: string | null
  technologies: unknown
  technologyCount: number
  failureReason: string | null
  createdAt: string
  finishedAt: string | null
}

export interface EnrichmentList {
  enrichments: EnrichmentRow[]
  byStatus?: Record<string, number>
}

export interface DetectedTechnology {
  name: string
  category: string
  confidence: string
  evidence?: Array<{ what?: string; where?: string; fragment?: string; sourceUrl?: string }>
}

// ── Intent signals (#977) ───────────────────────────────────────────────
export interface IntentSignal {
  id: string
  signalType: string
  signalCategory: string
  summary: string
  confidence: string
  status: string
  sourceUrl: string | null
  detectedAt: string
  evidence?: unknown
  /**
   * Provider facts, and — on an expired row — `supersededBy`, the observation
   * that overtook this signal. A signal a later run found to be false carries
   * the reason it was withdrawn, so "expired" is explained rather than bare.
   */
  metadata?: unknown
}

// ── Decision makers (#978) ──────────────────────────────────────────────
export interface DecisionMakerCandidate {
  id: string
  fullName: string
  rawTitle: string | null
  normalizedTitle: string | null
  roleGroup: string | null
  seniority: string | null
  companyMatch: string
  profileUrl: string | null
  location: string | null
  email: string | null
  phone: string | null
  confidence: string
  contactability: string
  outcome: string
  /** Why a person who was found is not on the shortlist. */
  exclusionReason?: string | null
  rank: number | null
  evidence?: unknown
  /** Which of the two approach routes this person is, when designated. */
  contactRole?: 'primary' | 'alternative' | null
  /**
   * Where this person's email came from, or why there is none.
   *
   * Derived on the server from the candidate's own evidence and the run's
   * per-provider metadata. Optional only because a response captured before
   * the field existed still has to render — its absence is a stale capture,
   * never a statement about the person.
   */
  emailContact?: {
    found: boolean
    /** The provider id, e.g. "crm_contacts" or "hunter". */
    source: string | null
    /** That provider as an operator would say it. */
    sourceLabel: string | null
    note: string
  }
}

// ── Website audit (#979) ────────────────────────────────────────────────
export interface AuditRun {
  id: string
  crmCompanyId: string
  companyName: string | null
  startUrl: string | null
  rootHost: string | null
  status: string
  pagesFetched: number
  productPages: number
  categoryPages: number
  otherPages: number
  httpErrors: number
  unreachablePages: number
  createdAt: string
  finishedAt?: string | null
  /**
   * Which of the four evidence states this run reached.
   *
   * Carried on the run as well as on the customer view, because the state
   * that most needs saying is the one the customer view cannot reach: a
   * company with no website never gets a report, so the customer view does
   * not exist and "nothing was read" is only available here.
   */
  productEvidence?: ProductEvidence
  /** Which case the End PDP link is in. Null for runs made before the End PDP audit. */
  pdpAssessment?: PdpAssessment | null
}

// ── The End PDP audit (GET /website-audit/runs/:id/pdp) ─────────────────────

export type PdpCase = 'valid_product' | 'link_problem' | 'no_link'

export interface PdpAssessment {
  case: PdpCase
  issue: string | null
  endPdpValue: string | null
  url: string | null
  finalUrl: string | null
  httpStatus: number | null
  pageType: string | null
  productName: string | null
  headline: string
  explanation: string
  recommendations: string[]
  suggestedProductUrls: string[]
  signals: string[]
}

export type PdpAttributeSource = 'page' | 'manufacturer' | 'enriched'

export interface PdpEnrichedAttribute {
  name: string
  value: string
  source: PdpAttributeSource
  sourceUrl: string | null
}

export interface PdpEnrichment {
  status: 'ready' | 'failed'
  reason: string | null
  generatedAt: string
  model: string | null
  source: {
    url: string
    productName: string
    sku: string | null
    price: string | null
    currency: string | null
    availability: string | null
    images: string[]
    observedFields: Array<{ field: string; value: string }>
    missingFields: string[]
  }
  research: {
    attempted: boolean
    note: string | null
    sources: Array<{ ref: string; url: string; title: string | null; read: boolean; reason: string | null }>
  }
  enriched: {
    enrichedTitle: string
    categoryPath: string[]
    industryLabel: string
    keyTransformation: string
    executiveSummary: string
    attributes: PdpEnrichedAttribute[]
    documents: Array<{ title: string; url: string | null; source: 'page' | 'manufacturer' | 'recommended' }>
  } | null
  checks: { relabelledToEnriched: number; droppedCommercial: number; droppedClaimSentences: number }
}

export interface PdpAudit {
  auditRunId: string
  companyName: string | null
  assessment: PdpAssessment | null
  enrichment: PdpEnrichment | null
  captures: { before: boolean; after: boolean }
}

export interface CatalogFinding {
  /** Which company this belongs to. Checked before it is rendered. */
  crmCompanyId: string
  id: string
  code: string
  title: string
  category: string
  priority: 'high' | 'medium' | 'low' | string
  metric: string
  finding: string
  impact: string
  recommendation: string
  affectedCount: number
  observedCount: number
  sampleSize: number
  sampleUnit: string
  evidence?: Array<{ observationId?: string; sourceUrl?: string; fragment?: string; field?: string }>
}

// ── Approval (#980) ─────────────────────────────────────────────────────
export interface ApprovalState {
  reportId: string
  status: string
  currentRevision: number
  approvedRevision: number | null
  lockVersion: number
  reviewerCrmUserId: string | null
  reviewerEmail: string | null
  reviewedAt: string | null
  decisionReason?: string | null
}

export interface ApprovalEvent {
  id: string
  action: string
  fromStatus: string | null
  toStatus: string
  reviewerEmail: string | null
  reason: string | null
  occurredAt: string
}

// ── Workbench (#981) ────────────────────────────────────────────────────
// ── The customer-facing reading of an audit run ─────────────────────────
//
// What the Audit Report and AI Workbench screens render. Deliberately the
// customer's story rather than the audit's internals: their products, their
// images, their categories, and what their pages do not publish.

/** One attribute read out of a published value by rule, with the words it came from. */
export interface DerivedAttribute {
  /** The name it takes in a structured record, e.g. "Pack / Capacity". */
  label: string
  /** The value, in the page's own characters. Always a literal part of `before`. */
  value: string
  /** The stretch of published text the value was read out of, verbatim. */
  sourceText: string
}

/** One field of one product, as published and as it would be structured. */
export interface RecordField {
  field: string
  label: string
  group: string
  /** Exactly what the page publishes. Null when it publishes nothing. */
  before: string | null
  /** The same value, named. NEVER a value the page did not publish. */
  after: string | null
  state: 'observed' | 'restructured' | 'absent' | string
  /**
   * The attributes this field's own text states — the pack size in the
   * sentence, the application it names — each with the words they came from.
   * Empty is a correct and common result. Optional here because a response
   * captured before the record carried them still has to render.
   */
  derivedAttributes?: DerivedAttribute[]
  /**
   * For an absent field, what the customer should publish. Advice about the
   * field, never a value for it, and null wherever a value exists.
   */
  recommendation?: string | null
  method: string | null
  sourcePath: string | null
  sourceUrl: string | null
}

/**
 * The page's own furniture, for showing a product the way its site shows it.
 *
 * Every field is OBSERVED. The crawler records no logo, navigation bar or
 * footer — image extraction actively discards logos — so a mock of the page
 * has these and nothing more. What is missing is missing, not imagined.
 */
export interface PageContext {
  pageTitle: string | null
  /** The site naming itself in its own page title. Null when it does not. */
  siteName: string | null
  breadcrumbs: string | null
  host: string | null
}

/** One real product from the customer's own site, before and after. */
export interface EnrichedRecord {
  crmCompanyId: string
  auditRunId: string
  pageId: string
  sourceUrl: string
  /** How the page presents itself. Absent on a response captured before this. */
  pageContext?: PageContext
  title: string
  imageUrl: string | null
  fields: RecordField[]
  observedCount: number
  restructuredCount: number
  absentCount: number
  /** The sum of every field's derivedAttributes. Absent on an older response. */
  derivedAttributeCount?: number
  beforeSummary: string
  afterSummary: string
  keyTransformation: string
}

export interface SectorGap {
  field: string
  label: string
  published: number
  sample: number
}

export interface CustomerViewGap extends SectorGap {
  /** The gap said the way a customer would say it. */
  statement: string
}

export interface Sector {
  name: string
  pageCount: number
  evidenceUrls: string[]
  gaps: SectorGap[]
}

// ── The recommended attribute schema ────────────────────────────────────
//
// Mirrors src/websiteaudit/recommendedSchema.ts. The category is read from
// the run's own pages or reported as not determined; the attributes are the
// FIELDS a buyer in that category filters on. A `recommended` attribute has
// no value, by construction, because the only value it could carry is one
// that was made up — and the screen must not undo that.

export type SchemaCategory = 'cleaning' | 'plumbing' | 'electrical' | 'industrial' | 'building' | 'general'

export type RecommendedAttributeState = 'observed' | 'derived' | 'recommended'

export interface RecommendedAttribute {
  /** Stable id within the profile, e.g. "pack_capacity". */
  field: string
  label: string
  /** Why a buyer needs it, starting lowercase ("so a buyer can …"). Never contains a value. */
  why: string
  state: RecommendedAttributeState
  /** The customer's own published text for observed/derived. ALWAYS null when recommended. */
  value: string | null
  /** Where that value was read from; null when recommended. */
  source: string | null
}

export interface RecommendedSchema {
  category: SchemaCategory
  categoryLabel: string
  /** False when the evidence did not support a category: say so, never show a sector label. */
  determined: boolean
  /** How the category was read, or why it could not be. Rendered verbatim. */
  note: string
  /** This website's own text that matched, one string each; the near-misses when not determined. */
  matchedEvidence: string[]
  /** The case study the states were computed against; null when the run inspected no product page. */
  assessedAgainst: { pageId: string; title: string; sourceUrl: string } | null
  attributes: RecommendedAttribute[]
  observedCount: number
  derivedCount: number
  /** Equals attributes.length whenever assessedAgainst is null. */
  recommendedCount: number
}

/** One product this company names on its own site. Never a product record. */
export interface CatalogEntry {
  /** Exactly as the page stated it. */
  name: string
  detailUrl: string | null
  imageUrl: string | null
  /**
   * The image's own file name, when it reads like a product code.
   *
   * Always labelled as a FILE NAME wherever it is shown. It is not a SKU and
   * must never be presented as one: the company has not published a code.
   */
  imageFileName: string | null
  strength: 'linked' | 'named' | 'image_alt'
  method: string
  sourcePath: string
  fragment: string
}

/**
 * Which of the four evidence states a run is in.
 *
 *   website_not_read     A — nothing was read, so nothing is known
 *   no_product_evidence  B — read, and the site names nothing it sells
 *   product_candidate    C — the site names products but publishes no
 *                            product page a machine can read
 *   product_page         D — a dedicated product page was read
 *
 * A and B are opposites and used to print the same sentence.
 */
export interface ProductEvidence {
  state: 'website_not_read' | 'no_product_evidence' | 'product_candidate' | 'product_page'
  stateCode: 'A' | 'B' | 'C' | 'D'
  /** 0 means there is nothing to build from, and `detail` says why. */
  tier: 0 | 1 | 2 | 3
  tierLabel: string
  headline: string
  detail: string
  entries: CatalogEntry[]
  counts: { linked: number; named: number; image_alt: number }
}

export interface CustomerView {
  crmCompanyId: string
  auditRunId: string
  companyName: string
  website: string | null
  auditDate: string
  pagesInspected: number
  productPagesInspected: number
  categoryPagesInspected: number
  /** Task #980. Governs publication, not whether this can be shown internally. */
  reportStatus: string
  approved: boolean
  headline: string
  summary: string
  scopeNote: string
  businessValue: string[]
  nextStep: string
  ctaLabel: string
  priorities: { high: number; medium: number; low: number }
  gaps: CustomerViewGap[]
  caseStudies: EnrichedRecord[]
  /**
   * What may honestly be shown when there is no product page.
   *
   * Optional for the same reason as the fields below it: a response captured
   * before the field existed still has to render. Its absence means the
   * capture is stale, never that the company publishes nothing.
   */
  productEvidence?: ProductEvidence
  sectors: { sectors: Sector[]; productPagesInspected: number; catalogueGaps: SectorGap[]; note: string }
  /**
   * The category-specific fields this customer should publish, and which of
   * them the first case study already does. Optional here for the same
   * reason `derivedAttributes` is: a response captured before the field
   * existed still has to render, and its absence is a stale capture, not a
   * finding about the website.
   */
  recommendedSchema?: RecommendedSchema
  /**
   * Wording AltiusNxt suggests for the hero product's page.
   *
   * The fourth state. OBSERVED, DERIVED and RECOMMENDED are all statements
   * about the customer's catalogue; this is a proposal about their copy, so it
   * arrives as its own object and is rendered under its own heading. Null when
   * the page published too little to compose from.
   */
  proposedContent?: ProposedContent | null
  /**
   * The customer's own page furniture and palette, from the audit run.
   *
   * Available as soon as the run has a product page — it describes their
   * WEBSITE, not our demonstration of it, so it does not wait for a report to
   * be approved or a demonstration to be built. Null when the run found no
   * product page to sample from.
   */
  websiteShell?: WebsiteShell | null
  pageTheme?: SiteTheme | null
  /**
   * Illustrative examples for what the hero page does NOT publish, keyed by
   * record field id ("product.gtin") or attribute id ("attr:concentration").
   * One set, shared with the report. Always rendered labelled EXAMPLE.
   */
  illustrativeExamples?: Record<string, IllustrativeExample>
}

/**
 * What a finished field looks like — never this product's data.
 *
 * `sample`  a generic value with units (measurements only).
 * `format`  bracketed structure only (identifiers and claims).
 */
export interface IllustrativeExample {
  value: string
  kind: 'sample' | 'format'
}

export interface WorkbenchField {
  field: string
  label: string
  before: string | null
  after: string | null
  delta: 'added' | 'restructured' | 'reworded' | 'unchanged' | 'still_absent' | string
  headline: boolean
  sourceUrl?: string | null
  sourcePath?: string | null
  sourceFragment?: string | null
  transformKind?: string
  transformRule?: string
}

export interface WorkbenchDemo {
  /** Which company this belongs to. Checked before it is rendered. */
  crmCompanyId: string
  id: string
  status: string
  statusReason: string | null
  companyName: string | null
  productName: string | null
  productPageUrl: string | null
  /**
   * The product's own image, as published on its page.
   *
   * Null when the page published none. The interface says so rather than
   * showing a placeholder, for the same reason the AFTER column never
   * invents a value.
   */
  productImageUrl?: string | null
  /**
   * The customer's own page furniture, captured when the demo was built.
   *
   * Null on demos built before capture existed; the preview then says which
   * parts it has no record of rather than drawing something in their place.
   */
  websiteShell?: WebsiteShell | null
  /** Colours and fonts sampled from the same page. */
  theme?: SiteTheme | null
  observedFieldCount: number
  totalFieldCount: number
  improvedFieldCount: number
  builtFromUnapproved: boolean
  sourceReportStatus: string | null
  generatedAt: string
  fields?: WorkbenchField[]
  valuePoints?: Array<{ title: string; why: string }>
}

// ── Outreach (#982) ─────────────────────────────────────────────────────
export interface ChannelStatus {
  channel: string
  provider: string
  status: string
  reason?: string
  remediation?: string
}

export interface OutreachAction {
  id: string
  channel: string
  stepNumber: number
  status: string
  statusReason: string | null
  providerName: string | null
  providerStatus: string | null
  contactName: string | null
  destination: string | null
  scheduledAt: string | null
  sentAt: string | null
}

export interface OutreachCampaign {
  campaignId?: string
  id?: string
  companyName: string | null
  crmCompanyId?: string
  status?: string
  dryRun?: boolean
  startsAt?: string
  actions: OutreachAction[]
}

// ── Engagement (#983) ───────────────────────────────────────────────────
/** Who performed an act. Classified by the backend, never re-derived here. */
export type EventActor = 'prospect' | 'altiusnxt' | 'system'

export interface EngagementEvent {
  id: string
  eventType: string
  /**
   * The canonical actor, from the API.
   *
   * The interface previously re-derived this from the event type with its own
   * pattern list, which classified infrastructure events (a bounce, a delivery
   * receipt) as AltiusNXT actions. The classification lives in one place now.
   */
  actor: EventActor
  channel: string
  source: string
  sourceProvider: string | null
  occurredAt: string
  receivedAt: string
  freshnessLabel: string
  ageHours: number
  timestampNote: string | null
  sessionRef: string | null
  workbenchDemoId: string | null
  outreachActionId: string | null
  auditRunId: string | null
  evidence: { what: string; where: string | null; how: string; referenceKind: string | null; referenceId: string | null }
  metadata: Record<string, unknown>
}

// GET /engagement/companies/:id/understanding — Intent Source, Engagement and
// Qualification side by side (2026-09-24 restructure). Deliberately narrower
// than the underlying rows: no raw score, no threshold, no qualification
// reason — see src/engagement/understanding.ts on the backend for why.
export interface UnderstandingSignal {
  id: string
  signalType: string
  signalCategory: string
  summary: string
  sourceUrl: string | null
  detectedAt: string
}

export interface Understanding {
  crmCompanyId: string
  intentSource: {
    count: number
    byCategory: Record<string, number>
    signals: UnderstandingSignal[]
  }
  engagement: { level: string; policyStatus: string } | null
  qualification: { status: string } | null
  disclaimers: string[]
}

export interface EngagementSummary {
  crmCompanyId: string
  totalEvents: number
  prospectEvents: number
  ourEvents: number
  systemEvents: number
  byChannel: Record<string, number>
  byEventType: Record<string, number>
  bySource: Record<string, number>
  firstEventAt: string | null
  lastEventAt: string | null
  lastEventFreshness: string
  lastEventAgeHours: number | null
  distinctSessions: number
  channelsObserved: string[]
  channelsNotObserved: string[]
  note?: string
}

// ── Intent scoring (#984) ───────────────────────────────────────────────
export interface IntentScore {
  crmCompanyId: string
  scored: boolean
  reason?: string
  score?: number
  rawScore?: number
  scoreRange?: { min: number; max: number }
  clamped?: boolean
  level?: 'LOW' | 'MEDIUM' | 'HIGH'
  policyVersion?: string
  policyStatus?: string
  calculationVersion?: string
  evaluatedAt?: string
  contactability?: { status: string; reasons: string[] }
  eventsConsidered?: number
  eventsScored?: number
  eventsExcluded?: number
  note?: string
}

export interface ScoreContribution {
  engagementEventId: string
  eventType: string
  channel: string
  occurredAt: string
  policyRuleId: string
  dimension: string
  basePoints: number
  freshnessMultiplier: number
  freshnessLabel: string
  ageDays: number
  contribution: number
  excluded: boolean
  reason: string
  scoringPolicyVersion: string
}

export interface ScoreBreakdown {
  crmCompanyId: string
  score: number
  rawScore: number
  scoreRange: { min: number; max: number }
  clamped: boolean
  level: string
  policyVersion: string
  policyStatus: string
  calculationVersion: string
  evaluatedAt: string
  contactability: { status: string; reasons: string[] }
  contributions: ScoreContribution[]
  setAside: ScoreContribution[]
  totals: {
    counted: number
    setAside: number
    pointsFromPositive: number
    pointsFromNegative: number
    byChannel: Record<string, number>
    byEventType: Record<string, number>
  }
  note: string
}

export interface ScoreSnapshot {
  snapshotId: string
  score: number
  rawScore: number
  level: string
  clamped: boolean
  change: number | null
  policyVersion: string
  policyStatus: string
  calculationVersion: string
  evaluatedAt: string
  trigger: string
  eventsConsidered: number
  eventsScored: number
  contactability: string
  recordedAt: string
}

export interface ScoringPolicy {
  version: string
  status: string
  description: string
  minScore: number
  maxScore: number
  rules: Array<{
    ruleId: string
    eventType: string
    points: number
    dimension: string
    decay: string
    maxPerSession: number | null
    maxOccurrences: number | null
    maxContribution: number | null
    note: string
  }>
  decayBands: Array<{ fromDays: number; toDays: number | null; multiplier: number; label: string }>
  levelBands: Array<{ level: string; fromScore: number; toScore: number }>
  scoringActors: string[]
  notes: string[]
  note?: string
}

// ── Sales qualification (#985) ──────────────────────────────────────────
export interface Qualification {
  evaluated?: boolean
  id?: string
  crmCompanyId: string
  companyName: string | null
  status?: string
  stage?: string
  intentScore?: number
  threshold?: number
  aboveThreshold?: number
  reason?: string
  qualificationPolicyVersion?: string
  qualificationEngineVersion?: string
  scorePolicyVersion?: string
  scoreCalculationVersion?: string
  scoreEvaluatedAt?: string
  intentScoreSnapshotId?: string | null
  owner?: { crmUserId: string | null; name: string | null; email: string | null; source: string; reason: string | null }
  alert?: { status: string }
  followUp?: { status: string; dueAt: string | null }
  qualifiedAt?: string | null
  deQualifiedAt?: string | null
  evaluationCount?: number
  lastEvaluatedAt?: string
  whyQualified?: {
    summary: string
    intentScore: number
    threshold: number
    aboveThreshold: number
    keyObservedActions: Array<{
      engagementEventId: string
      intentScoreContributionId: string
      eventType: string
      channel: string
      contribution: number
      occurredAt: string
    }>
  }
  alerts?: Array<{
    id: string
    status: string
    provider: string
    destination: string
    delivered: boolean
    subject?: string
    body?: string
    reason: string | null
    createdAt: string
  }>
  followUpTasks?: Array<{
    id: string
    status: string
    provider: string
    destination: string
    title: string
    body?: string
    recommendedAction?: string
    owner?: string | null
    dueAt: string
    slaMinutes: number
    completionStatus: string
    reason: string | null
  }>
  reasonText?: string
  note?: string
}

export interface QualificationTransition {
  id: string
  transition: string
  from: string | null
  to: string
  previousScore: number | null
  score: number
  threshold: number
  difference: number
  reason: string
  qualificationPolicyVersion: string
  alertStatus: string | null
  taskStatus: string | null
  actorType: string
  occurredAt: string
}

export interface QualificationPolicy {
  version: string
  status: string
  description: string
  threshold: number
  deQualifyBand: number
  slaMinutes: number
  createAlert: boolean
  createFollowUpTask: boolean
  cancelTaskOnDeQualification: boolean
  notes: string[]
  providers?: {
    alert: Array<{ name: string; destination: string; status: string; reason?: string; remediation?: string }>
    task: Array<{ name: string; destination: string; status: string; reason?: string; remediation?: string }>
  }
  note?: string
}

// ── CRM sync (#986) ─────────────────────────────────────────────────────
export interface CrmSyncResource {
  resource: string
  result: string
  externalId: string | null
  reason?: string
  errorCode?: string | null
  retryable?: boolean
}

/**
 * One handoff waiting for a person, as GET /crm-sync/approvals/pending returns it.
 *
 * Deliberately narrow. The queue carries what a reviewer needs to decide —
 * company, status, score, the stated reason, owner, when and by whom it was
 * prepared, and whether it validated. The evidence chain behind it stays on the
 * server; anyone who wants it opens the prepared package.
 */
export interface PendingApproval {
  syncId: string
  qualificationId: string
  crmCompanyId: string
  companyName: string | null
  state: string
  stateLabel: string
  qualification: { status: string; score: number; reason: string }
  owner: { crmUserId: string | null; status: string }
  validation: { ok: boolean }
  preparedAt: string | null
  requestedByCrmUserId: string | null
  /** True when this viewer prepared it, so the policy will refuse their approval. */
  youPreparedThis: boolean
  /** Echoed back with a decision so a stale review is refused. */
  expectedUpdatedAt: string
}

export interface PendingApprovals {
  pending: PendingApproval[]
  count: number
  note: string
}

/** What the approve/reject endpoints answer with. */
export interface ApprovalDecision {
  syncId: string
  qualificationId?: string
  state: string
  stateLabel: string
  decision: 'approved' | 'rejected'
  decidedByCrmUserId: string
  reason: string
  resources?: CrmSyncResource[]
  errorCode?: string | null
}

export interface CrmSyncRecord {
  prepared?: boolean
  reason?: string
  syncId: string
  qualificationId: string
  crmCompanyId: string
  companyName: string | null
  state: string
  stateLabel: string
  provider: { name: string; status: string }
  mappingVersion: string
  payloadVersion: string
  externalKey: string
  resources: CrmSyncResource[]
  externalIds: Record<string, string>
  validation: { ok: boolean; issues: Array<{ check: string; severity: string; message: string }> }
  owner: { crmUserId: string | null; status: string }
  attempts: number
  lastAttemptAt: string | null
  lastError: { code: string; message: string } | null
  retryable: boolean
  syncedAt: string | null
  outbox?: {
    id: string
    state: string
    reason: string
    blockedBy: string | null
    attemptCount: number
    createdAt: string
  } | null
}

export interface CrmSyncProviderInfo {
  name: string
  destination: string
  capabilities: {
    canLookup: boolean
    canCreate: boolean
    canUpdate: boolean
    canUpsert: boolean
    canAttach: boolean
    resources: string[]
  }
  status: string
  reason?: string
  remediation?: string
}

export interface CrmSyncProviders {
  activeProvider: string
  providers: CrmSyncProviderInfo[]
  mappingVersion: string
  payloadVersion: string
  note: string
}

export interface CrmFieldMapping {
  source: string
  target: string
  resource: string
  disposition: 'write' | 'read_only_reference' | 'blocked_no_target_field'
  note?: string
}


/**
 * Suggested wording, composed from values the page already publishes.
 *
 * `supportedBy` is not decoration: it is the list a reviewer checks the
 * proposal against, which is what keeps "proposed" from drifting into
 * "asserted".
 */
export interface ProposedContent {
  overview: string
  bullets: string[]
  openQuestions: string[]
  supportedBy: Array<{ label: string; value: string; from: 'observed' | 'derived' }>
  note: string
}

/**
 * The customer's own page furniture, captured by the Workbench builder.
 *
 * Text and URLs only — never markup. The Workbench renders its own elements
 * from these values, which is what lets the enhanced tab keep the identical
 * shell while replacing what sits inside it. A screenshot could not do that.
 */
export interface ShellLink {
  label: string
  href: string | null
}

export interface WebsiteShell {
  captured: boolean
  reason: string | null
  sourceUrl: string | null
  siteName: string | null
  host: string | null
  logoUrl: string | null
  logoAlt: string | null
  nav: ShellLink[]
  hasSearch: boolean
  utility: ShellLink[]
  footerLinks: ShellLink[]
  footerText: string | null
  social: Array<{ platform: string; href: string }>
  /** Parts of the page that could not be read, named so the screen can say so. */
  notCaptured: string[]
}

/** Colours and fonts sampled from the live site, or the neutral default. */
export interface SiteTheme {
  source: 'live_sample' | 'neutral_default'
  reason: string | null
  primary: string
  accent: string
  ink: string
  surface: string
  muted: string
  fontFamily: string
  headingFamily: string
  logoUrl: string | null
  radius: string
  layoutFamily: string
}

/** GET /companies/search — the CRM's answer to a typed word. */
export interface CompanySearchHit {
  crmCompanyId: string
  companyName: string
  website: string | null
  industry: string | null
  country: string | null
  /** Whether the company's NAME matched, or the INDUSTRY it is filed under. */
  matchedOn: 'name' | 'industry'
}

export interface CompanySearch {
  query: string
  companies: CompanySearchHit[]
  /** CRM industries the words matched, if any. */
  industries: string[]
  /** CRM countries the words matched, which narrow the industries. */
  countries: string[]
  truncated: boolean
  industryReadError: string | null
  note: string
  /** The company the words name, when they name exactly one. */
  exact: CompanySearchHit | null
}

/** GET /companies/:id — one company, as the CRM holds it. */
export interface CrmCompanyRecord {
  crmCompanyId: string
  companyName: string
  website: string | null
  /** Why there is no website, when the CRM holds none we can use. */
  websiteNote: string | null
  industry: string | null
  country: string | null
  email: string | null
  phone: string | null
  contactPersons: string[]
  endPdpUrl: string | null
  linkedProfiles: string[]
  ownerName: string | null
  dealCount: number
  createdAt: string
}
