import { z } from 'zod'
import { env } from '../config/env.js'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'
import { htmlToText } from '../research/htmlToText.js'
import { fetchPageRaw } from '../research/pageFetch.js'
import { discoverPublicSources } from '../research/publicResearch.js'
import { findUnsupportedClaims } from './claimGuard.js'
import { extractPageObservations, extractProductObservations } from './extraction.js'
import {
  decode,
  extractDocumentLinks,
  extractHeadings,
  extractJsonLd,
  extractLinks,
  extractSpecPairs,
  hasType,
  jsonLdNodes,
} from './htmlStructure.js'
import { hostOf, resolveLink, sameSite } from './urls.js'

// PDP ENRICHMENT — FROM ONE CUSTOMER PRODUCT PAGE TO A FULL PRODUCT RECORD.
//
// The Website Audit reads ONE product page (the End PDP link). This module
// turns what that page published into the enriched product master record the
// report and the Workbench "After" page present: a normalised title, a category
// path, a description with feature bullets, a full technical specification
// matrix, documents, and the narrative the report template needs.
//
// Content is CREATED where the customer's page is thin — that is the point of
// the demonstration. What keeps it honest is that every attribute carries where
// its value came from, and that label is decided in CODE after the model has
// answered, never taken on the model's word:
//
//   page          the value appears in the text of the customer's own page
//   manufacturer  the value appears in a manufacturer/distributor page WE
//                 fetched, cited by URL
//   enriched      proposed by the model for this kind of product; shown in the
//                 After page, marked, and to be confirmed before publication
//
// A value the model labels "page" or "manufacturer" that cannot be found in the
// cited text is relabelled "enriched". Price and stock are commercial facts and
// are only ever taken from the customer's page. No URL is ever invented: every
// link in the result is a link a fetched page published.
//
// Generic by construction: nothing here names a company, an industry or a
// product. The same prompt, the same checks and the same shape serve a glove,
// a tap, a defibrillator or a pallet of cement.

// ── What the customer's page published ────────────────────────────────────

export interface SourcePageFacts {
  url: string
  host: string | null
  pageTitle: string | null
  productName: string
  breadcrumbs: string[]
  brand: string | null
  sku: string | null
  mpn: string | null
  gtin: string | null
  price: string | null
  currency: string | null
  availability: string | null
  description: string | null
  images: string[]
  specifications: Array<{ label: string; value: string }>
  documents: Array<{ title: string; url: string }>
  /** Every observed product field, as label/value, for the Before narrative. */
  observedFields: Array<{ field: string; value: string }>
  /** Expected product fields the page did not publish. */
  missingFields: string[]
  /** Plain text of the page, bounded. The only text "page" provenance may match. */
  text: string
}

const FIELD_LABEL: Record<string, string> = {
  'product.name': 'Product name',
  'product.sku': 'SKU',
  'product.mpn': 'Manufacturer part number',
  'product.gtin': 'GTIN / barcode',
  'product.brand': 'Brand',
  'product.category': 'Category',
  'product.description': 'Description',
  'product.specifications': 'Specifications',
  'product.attributes': 'Attributes',
  'product.dimensions': 'Dimensions',
  'product.weight': 'Weight',
  'product.units': 'Units of measure',
  'product.price': 'Price',
  'product.currency': 'Currency',
  'product.availability': 'Availability',
  'product.image': 'Product image',
  'product.documents': 'Technical documents',
}

export function readSourcePage(html: string, url: string, productName: string): SourcePageFacts {
  const product = extractProductObservations(html, url)
  const page = extractPageObservations(html, url)
  const value = (field: string): string | null =>
    product.find((o) => o.field === field && o.status === 'observed')?.value?.trim() || null

  const breadcrumbs = (page.find((o) => o.field === 'page.breadcrumbs' && o.status === 'observed')?.value ?? '')
    .split('>')
    .map((s) => s.trim())
    .filter(Boolean)

  const specifications = extractSpecPairs(html, 80)
    .map((p) => ({ label: decode(p.key).trim(), value: decode(p.value).trim() }))
    .filter((p) => p.label && p.value && p.label.length <= 80 && p.value.length <= 300)

  const documents = extractDocumentLinks(extractLinks(html, 600))
    .map((l) => ({ title: decode(l.text).trim() || fileName(l.href), url: resolveLink(l.href, url) }))
    .filter((d): d is { title: string; url: string } => Boolean(d.url))
    .slice(0, 6)

  const observedFields = product
    .filter((o) => o.status === 'observed' && o.value)
    .map((o) => ({ field: FIELD_LABEL[o.field] ?? o.field, value: o.value!.slice(0, 300) }))
  const missingFields = product
    .filter((o) => o.status !== 'observed')
    .map((o) => FIELD_LABEL[o.field] ?? o.field)

  return {
    url,
    host: hostOf(url),
    pageTitle: page.find((o) => o.field === 'page.title' && o.status === 'observed')?.value ?? null,
    productName,
    breadcrumbs,
    brand: value('product.brand'),
    sku: value('product.sku'),
    mpn: value('product.mpn'),
    gtin: value('product.gtin'),
    // A zero price is how many shops publish "price on request".
    price: Number(String(value('product.price') ?? '').replace(/[^0-9.]/g, '')) > 0 ? value('product.price') : null,
    currency: value('product.currency'),
    availability: readableAvailability(value('product.availability')),
    description: value('product.description') ?? metaDescription(page),
    images: productImages(html, url),
    specifications,
    documents,
    observedFields,
    missingFields,
    text: htmlToText(html).replace(/\s+/g, ' ').trim().slice(0, 12_000),
  }
}

function metaDescription(page: ReturnType<typeof extractPageObservations>): string | null {
  return page.find((o) => o.field === 'page.metaDescription' && o.status === 'observed')?.value ?? null
}

function readableAvailability(v: string | null): string | null {
  if (!v) return null
  const tail = v.split('/').pop() ?? v
  return tail.replace(/([a-z])([A-Z])/g, '$1 $2').trim()
}

function fileName(href: string): string {
  return decodeURIComponent(href.split('/').pop()?.split('?')[0] ?? 'Document')
}

/** Product images the page declares: JSON-LD first, then og:image, then gallery images. */
export function productImages(html: string, pageUrl: string, max = 6): string[] {
  const out: string[] = []
  const push = (raw: unknown) => {
    const s = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? (raw as Record<string, unknown>).url : null
    if (typeof s !== 'string' || !s.trim() || s.startsWith('data:')) return
    const abs = resolveLink(decode(s.trim()), pageUrl)
    if (!abs || out.includes(abs)) return
    const low = abs.toLowerCase()
    if (low.endsWith('.svg') || /(logo|sprite|icon|placeholder|blank|spacer|pixel|favicon|payment|badge)/.test(low)) return
    out.push(abs)
  }
  for (const { node } of jsonLdNodes(extractJsonLd(html))) {
    if (!hasType(node, 'Product', 'IndividualProduct', 'ProductModel')) continue
    const img = node.image
    ;(Array.isArray(img) ? img : [img]).forEach(push)
  }
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
  if (og?.[1]) push(og[1])
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    if (out.length >= max) break
    const m = tag.match(/\b(?:data-zoom-image|data-large_image|data-src|src)\s*=\s*["']([^"']+)["']/i)
    if (m?.[1] && /product|gallery|zoom|large|main|uploads|media|images?\//i.test(tag)) push(m[1].split(',')[0]!.trim().split(/\s+/)[0])
  }
  return out.slice(0, max)
}

// ── What the model returns ────────────────────────────────────────────────

const HeadingDetail = z.object({ heading: z.string().min(2).max(80), detail: z.string().min(10).max(500) })

export const EnrichmentOutput = z.object({
  enrichedTitle: z.string().min(5).max(200),
  brand: z.string().max(80).nullable(),
  series: z.string().max(80).nullable(),
  manufacturerPartNumber: z.string().max(80).nullable(),
  productType: z.string().min(2).max(100),
  categoryPath: z.array(z.string().min(1).max(80)).min(2).max(6),
  industryLabel: z.string().min(3).max(120),
  // Its 8-digit shape is checked in verifyEnrichment: Gemini's structured
  // output rejects a regex pattern in the response schema.
  unspsc: z.string().max(20).nullable(),
  description: z.object({
    intro: z.string().min(40).max(1200),
    bullets: z.array(z.string().min(5).max(300)).min(3).max(10),
  }),
  attributes: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        value: z.string().min(1).max(300),
        source: z.enum(['page', 'manufacturer', 'enriched']),
        /** "P" for the customer's page, "S1".."S9" for a research source. */
        sourceRef: z.string().max(4).nullable(),
      }),
    )
    // No length bounds here: Gemini refuses a response schema whose array
    // limits are long ("too many states for serving"). The 60-attribute cap and
    // the 8-attribute floor are enforced in verifyEnrichment instead.
    .min(1),
  recommendedDocuments: z.array(z.string().min(3).max(100)).max(5),
  attributeHighlights: z.array(HeadingDetail).min(3).max(8),
  beforeNarrative: z.array(z.string().min(20).max(800)).min(1).max(3),
  afterNarrative: z.array(z.string().min(20).max(800)).min(1).max(3),
  keyTransformation: z.string().min(40).max(700),
  introParagraph: z.string().min(80).max(1100),
  executiveSummary: z.string().min(80).max(1200),
  normalizationNotes: z.array(HeadingDetail).min(2).max(5),
  auditSummary: z.string().min(60).max(1000),
  keyImprovements: z.array(HeadingDetail).min(3).max(6),
  nextSteps: z.array(HeadingDetail).min(3).max(5),
})
export type EnrichmentModelOutput = z.infer<typeof EnrichmentOutput>

// ── What is stored and presented ──────────────────────────────────────────

export type AttributeSource = 'page' | 'manufacturer' | 'enriched'

export interface EnrichedAttribute {
  name: string
  value: string
  source: AttributeSource
  /** The page the value was found on. Null for enriched values. */
  sourceUrl: string | null
}

export interface EnrichedDocument {
  title: string
  /** A real link a fetched page published, or null for a recommended document. */
  url: string | null
  source: 'page' | 'manufacturer' | 'recommended'
}

export interface ResearchSource {
  ref: string
  url: string
  title: string | null
  read: boolean
  reason: string | null
}

export interface PdpEnrichment {
  status: 'ready' | 'failed'
  reason: string | null
  generatedAt: string
  model: string | null
  costUsd: number
  source: Omit<SourcePageFacts, 'text'>
  research: { attempted: boolean; note: string | null; sources: ResearchSource[] }
  enriched: Omit<EnrichmentModelOutput, 'attributes' | 'recommendedDocuments'> & {
    attributes: EnrichedAttribute[]
    documents: EnrichedDocument[]
    price: string | null
    currency: string | null
    availability: string | null
    images: string[]
  } | null
  /** What the post-checks changed, so the result can be audited. */
  checks: { relabelledToEnriched: number; droppedCommercial: number; droppedClaimSentences: number }
}

// ── Checks applied after the model answers ────────────────────────────────

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[™®©]/g, '')
    .replace(/[^a-z0-9%°.,/+-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** A value counts as present in a text when its normalised form occurs there. */
export function valueAppearsIn(value: string, text: string): boolean {
  const v = norm(value)
  if (!v) return false
  const t = norm(text)
  if (t.includes(v)) return true
  // Multi-part values ("Cold; Wet; Oil") are present when every part is.
  const parts = value.split(/[;,|]/).map(norm).filter((p) => p.length >= 2)
  return parts.length > 1 && parts.every((p) => t.includes(p))
}

/** Commercial facts only the customer's page may state. */
const COMMERCIAL = /\b(price|cost|rrp|msrp|stock|availability|in stock|lead time|delivery|shipping|discount)\b/i

/** Drops sentences that make financial, ranking or guarantee claims. */
export function withoutClaimSentences(text: string): { text: string; dropped: number } {
  const sentences = text.split(/(?<=[.!?])\s+/)
  const kept = sentences.filter((s) => findUnsupportedClaims(s).filter((v) => v.pattern !== 'percentage').length === 0)
  return { text: kept.join(' ').trim(), dropped: sentences.length - kept.length }
}

export function verifyEnrichment(
  out: EnrichmentModelOutput,
  page: SourcePageFacts,
  sources: Array<{ ref: string; url: string; text: string; documents: Array<{ title: string; url: string }> }>,
): { enriched: NonNullable<PdpEnrichment['enriched']>; checks: PdpEnrichment['checks'] } {
  const checks = { relabelledToEnriched: 0, droppedCommercial: 0, droppedClaimSentences: 0 }
  const pageText = [page.text, ...page.specifications.map((s) => `${s.label} ${s.value}`)].join(' ')
  const byRef = new Map(sources.map((s) => [s.ref.toUpperCase(), s]))

  const attributes: EnrichedAttribute[] = []
  const seen = new Set<string>()
  for (const a of out.attributes.slice(0, 80)) {
    if (attributes.length >= 60) break
    const key = a.name.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    if (COMMERCIAL.test(a.name)) {
      // Price and stock come from the page's own record below, never from here.
      checks.droppedCommercial++
      continue
    }

    let source: AttributeSource = a.source
    let sourceUrl: string | null = null
    if (source === 'page') {
      if (valueAppearsIn(a.value, pageText)) sourceUrl = page.url
      else source = 'enriched'
    } else if (source === 'manufacturer') {
      const s = a.sourceRef ? byRef.get(a.sourceRef.toUpperCase()) : undefined
      if (s && valueAppearsIn(a.value, s.text)) sourceUrl = s.url
      else {
        // Found on the customer's page after all? Then that is its source.
        if (valueAppearsIn(a.value, pageText)) {
          source = 'page'
          sourceUrl = page.url
        } else source = 'enriched'
      }
    } else if (valueAppearsIn(a.value, pageText) && a.value.trim().length >= 3) {
      // A value the model called enriched that the page actually publishes.
      source = 'page'
      sourceUrl = page.url
    }
    if (source === 'enriched' && a.source !== 'enriched') checks.relabelledToEnriched++
    attributes.push({ name: a.name.trim(), value: a.value.trim(), source, sourceUrl })
  }

  const documents: EnrichedDocument[] = [
    ...page.documents.map((d) => ({ title: d.title, url: d.url, source: 'page' as const })),
    ...sources.flatMap((s) => s.documents.map((d) => ({ title: d.title, url: d.url, source: 'manufacturer' as const }))),
  ]
  const docUrls = new Set<string>()
  const realDocs = documents.filter((d) => (d.url && !docUrls.has(d.url) ? (docUrls.add(d.url), true) : false)).slice(0, 4)
  const recommended = out.recommendedDocuments
    .filter((t) => !realDocs.some((d) => d.title.toLowerCase() === t.toLowerCase()))
    .slice(0, Math.max(0, 4 - realDocs.length))
    .map((title) => ({ title, url: null, source: 'recommended' as const }))

  const clean = (s: string) => {
    // The shared safety preamble asks models to tag claims with their basis;
    // those tags are for review, not for a customer document.
    const untagged = s.replace(/\s*\[(CRM data|Knowledge|Page data|AI inference|K\d+|P|S\d+)\]\s*/gi, ' ').replace(/\s+/g, ' ').trim()
    const r = withoutClaimSentences(untagged.replace(/\s+([.,;:!?])/g, '$1'))
    checks.droppedClaimSentences += r.dropped
    return r.text
  }
  const cleanHD = (items: Array<{ heading: string; detail: string }>) =>
    items.map((i) => ({ heading: i.heading, detail: clean(i.detail) })).filter((i) => i.detail)

  return {
    checks,
    enriched: {
      enrichedTitle: out.enrichedTitle,
      brand: out.brand ?? page.brand,
      series: out.series,
      manufacturerPartNumber: out.manufacturerPartNumber ?? page.mpn,
      productType: out.productType,
      categoryPath: out.categoryPath,
      industryLabel: out.industryLabel,
      unspsc: out.unspsc && /^\d{8}$/.test(out.unspsc.trim()) ? out.unspsc.trim() : null,
      description: { intro: clean(out.description.intro), bullets: out.description.bullets.map(clean).filter(Boolean) },
      attributes,
      documents: [...realDocs, ...recommended],
      attributeHighlights: cleanHD(out.attributeHighlights),
      beforeNarrative: out.beforeNarrative.map(clean).filter(Boolean),
      afterNarrative: out.afterNarrative.map(clean).filter(Boolean),
      keyTransformation: clean(out.keyTransformation),
      introParagraph: clean(out.introParagraph),
      executiveSummary: clean(out.executiveSummary),
      normalizationNotes: cleanHD(out.normalizationNotes),
      auditSummary: clean(out.auditSummary),
      keyImprovements: cleanHD(out.keyImprovements),
      nextSteps: cleanHD(out.nextSteps),
      price: page.price,
      currency: page.currency,
      availability: page.availability,
      images: page.images,
    },
  }
}

// ── The run ───────────────────────────────────────────────────────────────

const MAX_RESEARCH_PAGES = 3

/**
 * Whether a research page is about this product: it carries the part number or
 * SKU, or most of the distinctive words of the brand and product name.
 */
export function mentionsProduct(
  text: string,
  page: Pick<SourcePageFacts, 'productName' | 'mpn' | 'sku' | 'brand'>,
): boolean {
  const t = norm(text)
  for (const id of [page.mpn, page.sku]) {
    if (id && id.trim().length >= 4 && t.includes(norm(id))) return true
  }
  const words = norm(`${page.brand ?? ''} ${page.productName}`)
    .split(' ')
    .filter((w) => w.length >= 3 && !/^(the|and|with|for|from|pack|size|set|new)$/.test(w))
  if (words.length === 0) return false
  const hits = words.filter((w) => t.includes(w)).length
  return hits >= Math.max(2, Math.ceil(words.length * 0.6))
}

export async function enrichPdp(input: {
  tenantId: string
  runId: string
  companyName: string
  html: string
  url: string
  productName: string
}): Promise<PdpEnrichment> {
  const page = readSourcePage(input.html, input.url, input.productName)
  const { text: _text, ...sourceForStorage } = page
  const started = new Date().toISOString()
  let costUsd = 0

  // Manufacturer research: links from search, pages fetched by us.
  const research: PdpEnrichment['research'] = { attempted: false, note: null, sources: [] }
  const readSources: Array<{ ref: string; url: string; text: string; documents: Array<{ title: string; url: string }> }> = []
  const descriptor = [page.brand, page.productName, page.mpn].filter(Boolean).join(' ').slice(0, 200)
  if (env.PUBLIC_RESEARCH_ENABLED && descriptor.length >= 4) {
    research.attempted = true
    try {
      const found = await discoverPublicSources({
        tenantId: input.tenantId,
        companyName: descriptor,
        domain: null,
        topic: 'product_specifications',
        maxSources: 6,
        feature: 'pdp_enrichment_research',
      })
      costUsd += found.costUsd
      research.note = found.reason
      let n = 0
      for (const s of found.sources) {
        if (readSources.length >= MAX_RESEARCH_PAGES) break
        const ref = `S${++n}`
        const res = await fetchPageRaw(s.url)
        const finalUrl = res.finalUrl ?? s.url
        // The customer's own site is already the "page" source.
        if (sameSite(hostOf(finalUrl), page.host)) {
          research.sources.push({ ref, url: finalUrl, title: s.title, read: false, reason: 'Same site as the audited page.' })
          continue
        }
        const text = res.ok ? htmlToText(res.html).replace(/\s+/g, ' ').trim() : ''
        if (!res.ok || text.length < 200) {
          research.sources.push({ ref, url: finalUrl, title: s.title, read: false, reason: res.reason ?? 'Too little readable text.' })
          continue
        }
        // A page that does not mention the product is not evidence about it.
        if (!mentionsProduct(text, page)) {
          research.sources.push({ ref, url: finalUrl, title: s.title, read: false, reason: 'The page does not mention this product.' })
          continue
        }
        const documents = extractDocumentLinks(extractLinks(res.html, 600))
          .map((l) => ({ title: decode(l.text).trim() || fileName(l.href), url: resolveLink(l.href, finalUrl) }))
          .filter((d): d is { title: string; url: string } => Boolean(d.url))
          .slice(0, 3)
        readSources.push({ ref, url: finalUrl, text: text.slice(0, 8_000), documents })
        research.sources.push({
          ref,
          url: finalUrl,
          title: s.title ?? extractHeadings(res.html, 3)[0]?.text ?? null,
          read: true,
          reason: null,
        })
      }
    } catch (err) {
      research.note = `Manufacturer research failed: ${(err as Error).message}`
    }
  } else if (!env.PUBLIC_RESEARCH_ENABLED) {
    research.note = 'PUBLIC_RESEARCH_ENABLED is off, so no manufacturer data was looked up.'
  }

  try {
    const result = await getLlm().generate({
      promptKey: 'pdp.enrich',
      variables: {
        companyName: input.companyName,
        sourcePage: JSON.stringify(
          {
            url: page.url,
            productName: page.productName,
            pageTitle: page.pageTitle,
            breadcrumbs: page.breadcrumbs,
            brand: page.brand,
            sku: page.sku,
            mpn: page.mpn,
            gtin: page.gtin,
            price: page.price,
            currency: page.currency,
            availability: page.availability,
            description: page.description,
            specifications: page.specifications,
            documents: page.documents,
            imageCount: page.images.length,
            observedFields: page.observedFields,
            missingFields: page.missingFields,
          },
          null,
          1,
        ),
        pageText: page.text.slice(0, 8_000),
        researchSources: readSources.length
          ? readSources.map((s) => `[${s.ref}] ${s.url}\n${s.text}`).join('\n\n---\n\n')
          : '(no manufacturer pages were read)',
      },
      schema: EnrichmentOutput,
      feature: 'pdp_enrichment',
      tenantId: input.tenantId,
      runId: null,
    })
    costUsd += result.costUsd
    const { enriched, checks } = verifyEnrichment(result.data, page, readSources)
    return {
      status: 'ready',
      reason: null,
      generatedAt: started,
      model: result.model,
      costUsd,
      source: sourceForStorage,
      research,
      enriched,
      checks,
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message, runId: input.runId }, 'pdp enrichment failed')
    return {
      status: 'failed',
      reason: `The enriched product record could not be generated: ${(err as Error).message}`.slice(0, 500),
      generatedAt: started,
      model: null,
      costUsd,
      source: sourceForStorage,
      research,
      enriched: null,
      checks: { relabelledToEnriched: 0, droppedCommercial: 0, droppedClaimSentences: 0 },
    }
  }
}
