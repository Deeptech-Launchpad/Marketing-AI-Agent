import type { Channel } from '../domain/enums.js'

// Deterministic content checks that run BEFORE the model-based brand review.
//
// Anything that can be checked by counting characters is checked here, not by
// an LLM: it is free, instant, and cannot hallucinate a pass.

export interface ValidationIssue {
  severity: 'error' | 'warning'
  code: string
  message: string
  assetName?: string
  variantLabel?: string
}

interface ChannelLimits {
  headlineMax: number
  bodyMax: number
  ctaMax: number
}

// Conservative published limits. These govern GENERATION only — Phase 1
// publishes nothing, and there is no channel adapter. They exist so content is
// not generated in a shape that could never be posted.
const CHANNEL_LIMITS: Record<Channel, ChannelLimits> = {
  linkedin: { headlineMax: 150, bodyMax: 3000, ctaMax: 60 },
  meta: { headlineMax: 40, bodyMax: 2200, ctaMax: 30 },
  email: { headlineMax: 120, bodyMax: 5000, ctaMax: 80 },
  generic: { headlineMax: 200, bodyMax: 8000, ctaMax: 100 },
}

export interface CheckableVariant {
  label: string
  headline: string
  body: string
  callToAction: string
}

export interface CheckableAsset {
  channel: string
  name: string
  variants: CheckableVariant[]
}

function limitsFor(channel: string): ChannelLimits {
  return CHANNEL_LIMITS[channel as Channel] ?? CHANNEL_LIMITS.generic
}

export function checkChannelConstraints(assets: CheckableAsset[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const asset of assets) {
    const limits = limitsFor(asset.channel)
    for (const variant of asset.variants) {
      const check = (field: keyof ChannelLimits, value: string, label: string) => {
        if (value.length > limits[field]) {
          issues.push({
            severity: 'error',
            code: 'channel_length',
            message: `${label} is ${value.length} chars; ${asset.channel} allows ${limits[field]}.`,
            assetName: asset.name,
            variantLabel: variant.label,
          })
        }
      }
      check('headlineMax', variant.headline, 'Headline')
      check('bodyMax', variant.body, 'Body')
      check('ctaMax', variant.callToAction, 'Call to action')

      if (!variant.body.trim()) {
        issues.push({
          severity: 'error',
          code: 'empty_body',
          message: 'Body is empty.',
          assetName: asset.name,
          variantLabel: variant.label,
        })
      }
    }
  }

  return issues
}

// Claims that cannot be substantiated from the knowledge base are a real
// liability in outbound marketing. Flagged as warnings for the reviewer rather
// than blocking, because some are legitimate once a case study backs them.
const UNSUBSTANTIATED_PATTERNS: Array<[RegExp, string]> = [
  [/\b\d{2,3}\s?%\s+(increase|uplift|growth|improvement|reduction)/i, 'percentage claim'],
  [/\bguarantee(d)?\b/i, 'guarantee'],
  [/\b(number one|#1|market[- ]leading|best[- ]in[- ]class)\b/i, 'superlative'],
  [/\bROI of\b/i, 'ROI claim'],
]

export function checkClaims(assets: CheckableAsset[], hasEvidence: boolean): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const asset of assets) {
    for (const variant of asset.variants) {
      const text = `${variant.headline} ${variant.body} ${variant.callToAction}`
      for (const [pattern, kind] of UNSUBSTANTIATED_PATTERNS) {
        if (pattern.test(text)) {
          issues.push({
            severity: 'warning',
            code: 'unsubstantiated_claim',
            message: hasEvidence
              ? `Contains a ${kind} — confirm it is supported by the cited source.`
              : `Contains a ${kind} with no supporting case study or product document in the knowledge base.`,
            assetName: asset.name,
            variantLabel: variant.label,
          })
        }
      }
    }
  }
  return issues
}

/**
 * Brand guidelines are a business input that may not exist yet. When the corpus
 * has none, that is reported as a warning rather than passing silently — a
 * green validation result the reviewer cannot trust is worse than an honest gap.
 */
export function checkBrandCorpusPresent(chunkCount: number): ValidationIssue[] {
  if (chunkCount > 0) return []
  return [
    {
      severity: 'warning',
      code: 'no_brand_guidelines',
      message:
        'No brand_guidelines documents are in the knowledge base, so tone and claim rules were not enforced. Ingest them before treating this validation as meaningful.',
    },
  ]
}
