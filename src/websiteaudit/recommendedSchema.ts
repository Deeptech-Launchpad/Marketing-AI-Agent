import type { EnrichedRecord, RecordField } from './enrichedRecord.js'

// A CATEGORY-SPECIFIC RECOMMENDED ATTRIBUTE SCHEMA — fields, never values.
//
// One generic schema for every company was the complaint: a cleaning-chemical
// supplier and a plumbers' merchant were both told to "publish attributes",
// which tells neither of them what to publish. A buyer of floor cleaner
// filters on pack size, dilution and which surfaces it is safe on; a buyer of
// a compression elbow filters on material, size and connection type. The
// recommendation has to name THOSE fields, for the category this customer
// actually sells in.
//
// TWO RULES
//
//   · The category is READ from the run's own evidence: the sector names the
//     site publishes, its breadcrumbs and product categories, and the words in
//     its own product names and descriptions. Nothing is inferred from the
//     domain, the company name or an industry list. When the evidence does
//     not support a category the answer is "could not be determined", with a
//     general set of fields — never a guess dressed up as a reading.
//
//   · The schema names FIELDS, never values. A `recommended` attribute carries
//     no value at all, because the only value it could carry is one we made
//     up. Where a value IS shown it is the customer's own published text,
//     carried through from the enriched record: a field the page publishes
//     outright (`observed`), or an attribute deriveAttributes() read out of
//     the page's own prose (`derived`).
//
// Rules, not a model, for the reason enrichedRecord.ts gives: a model asked
// "what sector is this?" answers even where the site says nothing, and a
// plausible wrong sector is exactly what gets the whole report disbelieved.

export type SchemaCategory = 'cleaning' | 'plumbing' | 'electrical' | 'industrial' | 'building' | 'general'

export type RecommendedAttributeState = 'observed' | 'derived' | 'recommended'

export interface RecommendedAttribute {
  /** Stable identifier, e.g. "pack_capacity". Unique within a profile. */
  field: string
  label: string
  /** Why a buyer needs it, in the customer's terms. Advice about the field, never a value for it. */
  why: string
  /**
   * observed     the first case-study page publishes it, as a field of its own
   *              or as a "Key: value" pair in its specification block
   * derived      deriveAttributes() already read it out of that page's prose
   * recommended  the page does not publish it; the field is named, the value is not
   */
  state: RecommendedAttributeState
  /** The customer's own published text for observed/derived. ALWAYS null for recommended. */
  value: string | null
  /** Where that value was read from, so a reader can check it. Null for recommended. */
  source: string | null
}

export interface RecommendedSchema {
  category: SchemaCategory
  /** The profile's display name, e.g. "Cleaning & hygiene products". */
  categoryLabel: string
  /** False when the evidence did not support a category and `general` stands in. */
  determined: boolean
  /** One or two plain sentences: how the category was read, or why it could not be. */
  note: string
  /** Each piece of this website's own text that matched, with the word it matched on. */
  matchedEvidence: string[]
  /** The case study the states were computed against; null when the run has no product page to check. */
  assessedAgainst: { pageId: string; title: string; sourceUrl: string } | null
  attributes: RecommendedAttribute[]
  observedCount: number
  derivedCount: number
  recommendedCount: number
}

/** Everything the classifier may read. All of it comes from ONE run, and so from one company. */
export interface SchemaEvidence {
  /** Sector names exactly as analyseSectors() returned them. */
  sectorNames: string[]
  /** Raw page.breadcrumbs / product.category / category.name observation values. */
  categoryTexts: string[]
  /** Observed product.name values. */
  productNames: string[]
  /** Observed product.description values. */
  productDescriptions: string[]
}

// ── Category profiles ───────────────────────────────────────────────────────
//
// `recordField` names the structured record field that carries the attribute
// outright, where one exists. `derivedLabel` names the deriveAttributes() rule
// that reads it out of prose. `specKeys` matches the key of a "Key: value"
// pair the way a specification table prints it. All three are ways of finding
// the customer's OWN value; none of them composes one.

interface AttributeSpec {
  field: string
  label: string
  why: string
  recordField?: string
  derivedLabel?: string
  specKeys?: RegExp
}

interface CategoryProfile {
  category: SchemaCategory
  label: string
  /** Plain words. Matched whole, case-insensitively, with an optional plural. */
  keywords: string[]
  attributes: AttributeSpec[]
}

const APPLICATION_KEYS = /^(?:applications?|uses?|suitable for|for use (?:on|in)|ideal for)$/i
const DIMENSION_KEYS = /^(?:dimensions?|size|w ?x ?h ?x ?d|width|height|depth|length|thickness)$/i
const MATERIAL_KEYS = /^(?:material|body material|construction|composition)$/i

const PROFILES: CategoryProfile[] = [
  {
    category: 'cleaning',
    label: 'Cleaning & hygiene products',
    keywords: [
      'cleaning', 'cleaner', 'janitorial', 'detergent', 'degreaser', 'disinfectant', 'sanitiser', 'sanitizer',
      'hygiene', 'washroom', 'bleach', 'descaler', 'limescale', 'floor care', 'floor cleaner', 'mop', 'wipe',
      'soap', 'hand wash', 'laundry', 'cleaning chemical', 'bin liner', 'bin bag', 'refuse sack', 'paper towel',
      'toilet roll', 'toilet tissue', 'hand towel', 'air freshener', 'polish', 'window cleaner', 'glass cleaner',
      'washing up', 'dishwasher', 'antibacterial', 'anti-bacterial', 'biocide', 'odour',
    ],
    attributes: [
      {
        field: 'pack_capacity',
        label: 'Pack / Capacity',
        // No example quantities anywhere in this advice: beside a `recommended`
        // row, "5L, 25L drum" reads as the customer's own range.
        why: 'so a buyer can order the right pack or container size without asking',
        derivedLabel: 'Pack / Capacity',
        specKeys: /^(?:pack(?: size)?|size|capacity|volume|contents?)$/i,
      },
      {
        field: 'application',
        label: 'Application',
        why: 'so a buyer can find the product for their task — floors, kitchens, washrooms — from a filter',
        derivedLabel: 'Application',
        specKeys: APPLICATION_KEYS,
      },
      {
        field: 'compatibility',
        label: 'Surface / material compatibility',
        why: 'so a buyer knows which surfaces it is safe on before it damages one',
        specKeys: /^(?:compatib\w*|surfaces?|suitable surfaces?|safe on)$/i,
      },
      {
        field: 'concentration',
        label: 'Concentration / dilution',
        why: 'so a buyer can compare cost per use across concentrates and ready-to-use products',
        specKeys: /^(?:concentrat\w*|dilution(?: (?:rate|ratio))?)$/i,
      },
      {
        field: 'usage',
        label: 'Usage / directions',
        why: 'so directions for use travel with the product into every listing and feed',
        specKeys: /^(?:usage|directions?(?: for use)?|instructions?|how to use|dosage)$/i,
      },
      {
        field: 'safety_documentation',
        label: 'Safety data & documentation',
        why: 'so a buyer can download the safety data sheet (SDS / COSHH) instead of requesting it',
        recordField: 'product.documents',
        specKeys: /^(?:sds|msds|safety data sheet|coshh|hazard\w*|un number|signal word)$/i,
      },
    ],
  },
  {
    category: 'plumbing',
    label: 'Plumbing, heating & bathroom products',
    keywords: [
      'plumbing', 'plumber', 'pipe', 'pipework', 'pipe fitting', 'compression', 'push-fit', 'push fit', 'solder',
      'valve', 'tap', 'mixer', 'basin', 'bath', 'bathroom', 'shower', 'toilet', 'cistern', 'radiator', 'boiler',
      'central heating', 'brassware', 'sanitaryware', 'underfloor heating', 'towel rail', 'wc', 'urinal',
    ],
    attributes: [
      {
        field: 'material',
        label: 'Material',
        why: 'so a buyer can match brass, copper or plastic to the rest of the installation',
        derivedLabel: 'Material',
        specKeys: MATERIAL_KEYS,
      },
      {
        field: 'size',
        label: 'Size / nominal bore',
        why: 'so a fitting is never ordered for the wrong pipe size',
        specKeys: /^(?:size|nominal (?:bore|size)|pipe size|diameter|bore|dn|thread(?: size)?|bsp)$/i,
      },
      {
        field: 'connection',
        label: 'Connection type',
        why: 'so compression, push-fit, solder and threaded parts can be filtered apart',
        specKeys: /^(?:connections?(?: type)?|connector|fitting type|end connection|thread type)$/i,
      },
      {
        field: 'finish',
        label: 'Finish',
        why: 'so chrome, brushed and matt black ranges can be filtered by look',
        derivedLabel: 'Colour',
        specKeys: /^(?:finish|colou?r|plating)$/i,
      },
      {
        field: 'installation_type',
        label: 'Installation type',
        why: 'so wall-mounted, deck-mounted and concealed products are found by the way they fit',
        specKeys: /^(?:installation(?: type)?|mounting(?: type)?|fitting|fixing)$/i,
      },
      {
        field: 'standards',
        label: 'Standards / approvals',
        why: 'so a specifier can confirm WRAS or BS EN compliance without an enquiry',
        specKeys: /^(?:standards?|approvals?|wras|certification|compliance|kitemark)$/i,
      },
    ],
  },
  {
    category: 'electrical',
    label: 'Electrical & electronic products',
    keywords: [
      'electrical', 'electronic', 'electronics', 'cable', 'wiring', 'socket', 'switch', 'circuit breaker',
      'consumer unit', 'fuse', 'lighting', 'luminaire', 'lamp', 'bulb', 'led lighting', 'led bulb', 'led strip',
      'downlight', 'floodlight', 'dimmer', 'voltage', 'transformer', 'power supply', 'battery', 'charger',
      'inverter', 'solar panel', 'sensor', 'pcb', 'semiconductor', 'resistor', 'capacitor', 'relay',
      'microcontroller', 'plug', 'extension lead', 'trunking', 'conduit',
    ],
    attributes: [
      {
        field: 'model',
        label: 'Model / part number',
        why: 'so the exact variant can be matched against a manufacturer catalogue',
        recordField: 'product.mpn',
        specKeys: /^(?:model(?: no\.?| number)?|part (?:no\.?|number)|mpn)$/i,
      },
      {
        field: 'voltage',
        label: 'Voltage',
        why: 'so products for different supply voltages can be filtered apart before ordering',
        specKeys: /^(?:voltage|(?:rated|input|supply|operating) voltage)$/i,
      },
      {
        field: 'power',
        label: 'Power rating',
        why: 'so wattage and current can be compared without opening a datasheet',
        specKeys: /^(?:power(?: (?:rating|output|consumption))?|wattage|rated power|current|amps?|amperage|load)$/i,
      },
      {
        field: 'compatibility',
        label: 'Compatibility',
        why: 'so a buyer can confirm the product works with what they already have',
        specKeys: /^(?:compatib\w*|compatible with|works with|suitable for)$/i,
      },
      {
        field: 'dimensions',
        label: 'Dimensions',
        why: 'so a buyer can confirm it fits the enclosure or space before ordering',
        recordField: 'product.dimensions',
        derivedLabel: 'Dimensions',
        specKeys: DIMENSION_KEYS,
      },
      {
        field: 'certification',
        label: 'Certification / standards',
        why: 'so CE, UKCA and BS EN marks are visible to a specifier without an enquiry',
        specKeys: /^(?:certification|standards?|approvals?|compliance|ip rating|ce marking)$/i,
      },
    ],
  },
  {
    category: 'industrial',
    label: 'Industrial, engineering & tool products',
    keywords: [
      'industrial', 'tool', 'power tool', 'hand tool', 'machinery', 'machine', 'drill', 'saw', 'grinder',
      'abrasive', 'welding', 'welder', 'bearing', 'fastener', 'bolt', 'nut', 'hydraulic', 'pneumatic',
      'compressor', 'pump', 'motor', 'gearbox', 'conveyor', 'workshop', 'engineering', 'lubricant', 'ppe',
      'workwear', 'lifting', 'hoist', 'blade', 'spanner', 'wrench', 'socket set', 'cutting disc',
    ],
    attributes: [
      {
        field: 'capacity',
        label: 'Capacity / rating',
        why: 'so load, flow or output can be compared as a number rather than read out of prose',
        derivedLabel: 'Pack / Capacity',
        specKeys: /^(?:capacity|rating|rated (?:load|capacity)|load(?: capacity)?|swl|flow(?: rate)?|output)$/i,
      },
      {
        field: 'material',
        label: 'Material',
        why: 'so a buyer can match the material to the duty and the environment',
        derivedLabel: 'Material',
        specKeys: /^(?:material|body material|construction|grade)$/i,
      },
      {
        field: 'operating_range',
        label: 'Operating range',
        why: 'so temperature, pressure and speed limits can be checked against a requirement',
        specKeys:
          /^(?:operating (?:range|temperature|pressure)|temperature(?: range)?|pressure(?: (?:range|rating))?|max(?:imum)? (?:pressure|temperature|speed)|speed|rpm|working pressure)$/i,
      },
      {
        field: 'application',
        label: 'Application',
        why: 'so the product is found for the job it is built for — from a filter, not a phone call',
        derivedLabel: 'Application',
        specKeys: /^(?:applications?|uses?|suitable for|industry|sector)$/i,
      },
      {
        field: 'standards',
        label: 'Standards / certification',
        why: 'so a specifier can confirm ISO, BS EN or ATEX compliance without an enquiry',
        specKeys: /^(?:standards?|certification|approvals?|compliance|iso|atex|ce marking)$/i,
      },
    ],
  },
  {
    category: 'building',
    label: 'Building & construction supplies',
    keywords: [
      'building', 'builder', 'building supplies', 'builders merchant', 'timber', 'plasterboard', 'plaster',
      'insulation', 'brick', 'block', 'cement', 'concrete', 'aggregate', 'sand', 'roofing', 'roof tile',
      'cladding', 'decking', 'fencing', 'door', 'window', 'flooring', 'tile', 'paint', 'sealant', 'adhesive',
      'landscaping', 'paving', 'guttering', 'joinery', 'ironmongery', 'render', 'screed', 'mortar', 'plywood',
      'mdf', 'osb', 'skirting',
    ],
    attributes: [
      {
        field: 'dimensions',
        label: 'Dimensions',
        why: 'so length, width and thickness can be filtered and checked against a drawing',
        recordField: 'product.dimensions',
        derivedLabel: 'Dimensions',
        specKeys: DIMENSION_KEYS,
      },
      {
        field: 'material',
        label: 'Material',
        why: 'so timber, steel and composite options can be compared like for like',
        derivedLabel: 'Material',
        specKeys: /^(?:material|composition|construction|species)$/i,
      },
      {
        field: 'coverage_pack',
        label: 'Coverage / pack quantity',
        why: 'so a buyer can work out how many to order for the area they are covering',
        derivedLabel: 'Pack / Capacity',
        specKeys: /^(?:coverage|pack(?: (?:size|quantity))?|quantity(?: per pack)?|per pack|m2 per pack|units per pack)$/i,
      },
      {
        field: 'grade_standard',
        label: 'Grade / standard',
        why: 'so C24 timber, BS EN classes and fire ratings are visible to a specifier',
        specKeys: /^(?:grade|standards?|fire rating|class|certification|treatment)$/i,
      },
      {
        field: 'application',
        label: 'Application',
        why: 'so internal, external and structural uses can be filtered apart',
        derivedLabel: 'Application',
        specKeys: /^(?:applications?|uses?|suitable for|internal\/external|location)$/i,
      },
    ],
  },
  {
    category: 'general',
    label: 'General product record',
    // Never matched on: `general` is what stands in when nothing else is supported.
    keywords: [],
    attributes: [
      {
        field: 'application',
        label: 'Application',
        why: 'so buyers can find the product for their purpose from a filter',
        derivedLabel: 'Application',
        specKeys: APPLICATION_KEYS,
      },
      {
        field: 'pack_quantity',
        label: 'Pack / quantity',
        why: 'so an order quantity means the same thing as the quantity on the page',
        derivedLabel: 'Pack / Capacity',
        specKeys: /^(?:pack(?: size)?|quantity|capacity|volume)$/i,
      },
      {
        field: 'material',
        label: 'Material',
        why: 'so buyers can compare like for like',
        derivedLabel: 'Material',
        specKeys: MATERIAL_KEYS,
      },
      {
        field: 'dimensions',
        label: 'Dimensions',
        why: 'so a buyer can confirm it fits before ordering',
        recordField: 'product.dimensions',
        derivedLabel: 'Dimensions',
        specKeys: DIMENSION_KEYS,
      },
      {
        field: 'documents',
        label: 'Supporting documents',
        why: 'so a datasheet can be downloaded rather than requested',
        recordField: 'product.documents',
      },
    ],
  },
]

const GENERAL = PROFILES.find((p) => p.category === 'general')!

// ── Classification ──────────────────────────────────────────────────────────

type SourceKind = 'sector' | 'category' | 'name' | 'description'

// A site naming a category in its own navigation is the site asserting it;
// a word inside a description is the site mentioning it. The weights say so,
// and a description alone needs three distinct sector words to carry a
// reading on its own.
const SOURCE_WEIGHT: Record<SourceKind, number> = { sector: 3, category: 2, name: 2, description: 1 }

const SOURCE_LABEL: Record<SourceKind, string> = {
  sector: 'Category name',
  category: 'Breadcrumb / product category',
  name: 'Product name',
  description: 'Product description',
}

const SOURCE_PLURAL: Record<SourceKind, string> = {
  sector: 'category names',
  category: 'breadcrumbs and product categories',
  name: 'product names',
  description: 'product descriptions',
}

/** A single category-name match is enough; anything weaker is a mention, not a reading. */
const MIN_SCORE = 3
const MAX_EVIDENCE = 8

/** Whole-word, case-insensitive, optional plural; "push fit" also matches "push-fit". */
function keywordPattern(keyword: string): RegExp {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+')
  return new RegExp(`\\b${escaped}(?:e?s)?\\b`, 'i')
}

const KEYWORD_PATTERNS = new Map<string, RegExp>(
  PROFILES.flatMap((p) => p.keywords.map((k) => [k, keywordPattern(k)] as const)),
)

/** Page text arrives carrying the newlines and runs of spaces the markup had. */
function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

/**
 * The words the evidence was read from, verbatim.
 *
 * A window rather than a truncation with an ellipsis: an ellipsis would make
 * the quoted evidence something the page never wrote.
 */
function excerpt(text: string, index: number, length: number): string {
  const t = collapse(text)
  if (t.length <= 100) return t
  const start = Math.max(0, index - 40)
  return t.slice(start, Math.min(t.length, index + length + 40)).trim()
}

export interface CategoryDecision {
  category: SchemaCategory
  determined: boolean
  note: string
  matchedEvidence: string[]
  /** Every profile's score, highest first, for a reviewer who wants to see why. */
  scores: Array<{ category: SchemaCategory; score: number }>
}

function join(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/**
 * Reads the product category from the run's own evidence.
 *
 * Deterministic and rule-based: the same evidence always yields the same
 * decision, and a decision can always be traced to the words it rests on.
 * A category is emitted only when it clears MIN_SCORE AND leads outright;
 * evidence split evenly between two categories is reported as split, not
 * resolved by a coin-toss.
 */
export function classifyCategory(evidence: SchemaEvidence): CategoryDecision {
  const sources: Array<[SourceKind, string[]]> = [
    ['sector', evidence.sectorNames],
    ['category', evidence.categoryTexts],
    ['name', evidence.productNames],
    ['description', evidence.productDescriptions],
  ]

  const tally = new Map<SchemaCategory, { score: number; evidence: string[]; kinds: Set<SourceKind> }>()
  for (const profile of PROFILES) {
    if (profile.category === 'general') continue
    const entry = { score: 0, evidence: [] as string[], kinds: new Set<SourceKind>() }
    for (const [kind, texts] of sources) {
      // A keyword counts once per source kind, however many texts repeat it:
      // "Cleaning" in forty breadcrumbs is one assertion, not forty.
      const matched = new Set<string>()
      for (const raw of texts) {
        const text = collapse(raw)
        if (!text) continue
        for (const keyword of profile.keywords) {
          if (matched.has(keyword)) continue
          const m = KEYWORD_PATTERNS.get(keyword)!.exec(text)
          if (!m) continue
          matched.add(keyword)
          entry.kinds.add(kind)
          entry.evidence.push(`${SOURCE_LABEL[kind]} "${excerpt(text, m.index, m[0].length)}" matched "${keyword}"`)
        }
      }
      entry.score += matched.size * SOURCE_WEIGHT[kind]
    }
    tally.set(profile.category, entry)
  }

  const scores = [...tally.entries()]
    .map(([category, e]) => ({ category, score: e.score }))
    .sort((a, b) => b.score - a.score || a.category.localeCompare(b.category))

  const best = scores[0]!
  const runnerUp = scores[1]!
  const bestEntry = tally.get(best.category)!
  const labelOf = (c: SchemaCategory) => PROFILES.find((p) => p.category === c)!.label.toLowerCase()

  if (best.score >= MIN_SCORE && best.score > runnerUp.score) {
    const kinds = [...bestEntry.kinds].map((k) => SOURCE_PLURAL[k])
    return {
      category: best.category,
      determined: true,
      note:
        `Read as ${labelOf(best.category)} from ${bestEntry.evidence.length} match(es) in this website's own ${join(kinds)}. ` +
        'The fields below are recommended for that category; where a value is shown it is this website’s own published text, and no other value is proposed.',
      matchedEvidence: bestEntry.evidence.slice(0, MAX_EVIDENCE),
      scores,
    }
  }

  let note: string
  if (best.score === 0) {
    note =
      'The inspected pages published no category names, breadcrumbs or product text that names a sector, so the product category could not be determined from this website. ' +
      'A general set of fields is shown instead; no sector has been assumed.'
  } else if (best.score === runnerUp.score) {
    const tied = scores.filter((s) => s.score === best.score).map((s) => labelOf(s.category))
    note =
      `The inspected pages point to ${join(tied)} with equal weight, so no single product category could be determined from this website. ` +
      'A general set of fields is shown instead; no sector has been assumed.'
  } else {
    note =
      `The inspected pages mention ${labelOf(best.category)} only in passing, which is not enough to read a product category from this website. ` +
      'A general set of fields is shown instead; no sector has been assumed.'
  }

  // The near-misses are still worth showing: they are why the answer is
  // "not determined" rather than "nothing found".
  const nearMisses = scores
    .filter((s) => s.score > 0)
    .flatMap((s) => tally.get(s.category)!.evidence)
    .slice(0, MAX_EVIDENCE)

  return { category: 'general', determined: false, note, matchedEvidence: nearMisses, scores }
}

// ── Assessing each attribute against the customer's own record ──────────────

const SPEC_PAIR_FIELDS = ['product.specifications', 'product.attributes']

/** A present field, with `before` narrowed to the string it must be. */
function presentField(record: EnrichedRecord, field: string): { field: RecordField; before: string } | null {
  const f = record.fields.find((x) => x.field === field)
  if (!f || f.state === 'absent' || f.before === null) return null
  return { field: f, before: f.before }
}

/**
 * Finds a "Key: value" pair whose key names the attribute.
 *
 * Only a chunk that STARTS with a key counts. A prose specification that
 * mentions "voltage" mid-sentence has not published a voltage field, and
 * reading one out of it would be an inference the customer can dispute.
 */
function findSpecPair(text: string, keys: RegExp): { key: string; value: string } | null {
  for (const chunk of text.split(/\s*(?:\||;|\n)\s*/)) {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(chunk.trim())
    if (!m) continue
    const key = m[1]!.trim()
    const value = m[2]!.trim()
    // "Rated Voltage (V)" is the voltage key with a unit hint; the hint is not the key.
    if (!value || !keys.test(key.replace(/\s*\(.*?\)\s*$/, ''))) continue
    return { key, value }
  }
  return null
}

function assess(spec: AttributeSpec, record: EnrichedRecord | null): Pick<RecommendedAttribute, 'state' | 'value' | 'source'> {
  if (!record) return { state: 'recommended', value: null, source: null }

  if (spec.recordField) {
    const p = presentField(record, spec.recordField)
    if (p) return { state: 'observed', value: p.before, source: `Published as "${p.field.label}" on this page` }
  }

  if (spec.specKeys) {
    for (const field of SPEC_PAIR_FIELDS) {
      const p = presentField(record, field)
      if (!p) continue
      const pair = findSpecPair(p.before, spec.specKeys)
      if (pair) {
        return {
          state: 'observed',
          value: pair.value,
          source: `Published as "${pair.key}" in the ${p.field.label.toLowerCase()} on this page`,
        }
      }
    }
  }

  if (spec.derivedLabel) {
    const d = record.fields.flatMap((f) => f.derivedAttributes).find((a) => a.label === spec.derivedLabel)
    if (d) return { state: 'derived', value: d.value, source: d.sourceText }
  }

  return { state: 'recommended', value: null, source: null }
}

/**
 * Builds the recommended attribute schema for ONE run.
 *
 * `record` is the run's first case study, or null when the run inspected no
 * product page — in which case every attribute is `recommended`, because
 * there is nothing of the customer's to check it against, and
 * `assessedAgainst` says so.
 */
export function buildRecommendedSchema(evidence: SchemaEvidence, record: EnrichedRecord | null): RecommendedSchema {
  const decision = classifyCategory(evidence)
  const profile = PROFILES.find((p) => p.category === decision.category) ?? GENERAL

  const attributes: RecommendedAttribute[] = profile.attributes.map((spec) => ({
    field: spec.field,
    label: spec.label,
    why: spec.why,
    ...assess(spec, record),
  }))

  return {
    category: profile.category,
    categoryLabel: profile.label,
    determined: decision.determined,
    note: decision.note,
    matchedEvidence: decision.matchedEvidence,
    assessedAgainst: record ? { pageId: record.pageId, title: record.title, sourceUrl: record.sourceUrl } : null,
    attributes,
    observedCount: attributes.filter((a) => a.state === 'observed').length,
    derivedCount: attributes.filter((a) => a.state === 'derived').length,
    recommendedCount: attributes.filter((a) => a.state === 'recommended').length,
  }
}
