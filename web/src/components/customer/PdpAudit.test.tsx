import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EnrichmentSummary, PdpAssessmentPanel } from './PdpAudit'
import type { PdpAssessment, PdpEnrichment } from '../../lib/types'

// THE END PDP AUDIT ON SCREEN.
//
// A link that is not a product page must say what is wrong AND what to do
// next; an enriched record must say where its values came from, and never let
// an AI-enriched value pass as the customer's own.

const assessment = (over: Partial<PdpAssessment> = {}): PdpAssessment => ({
  case: 'link_problem',
  issue: 'category_page',
  endPdpValue: 'https://shop.test/category/taps/',
  url: 'https://shop.test/category/taps/',
  finalUrl: 'https://shop.test/category/taps/',
  httpStatus: 200,
  pageType: 'category',
  productName: null,
  headline: 'End PDP points to a category page, not a product',
  explanation: 'The link opens a page that lists several products.',
  recommendations: ['Pick one of the product pages this page links to.', 'Run the Website Audit again.'],
  suggestedProductUrls: ['https://shop.test/category/taps/basin-mixer-1'],
  signals: [],
  ...over,
})

describe('PdpAssessmentPanel', () => {
  it('states the problem, the next steps and the product links the page published', () => {
    render(<PdpAssessmentPanel assessment={assessment()} companyName="Acme" />)
    expect(screen.getByText('Link needs attention')).toBeInTheDocument()
    expect(screen.getByText(/category page, not a product/)).toBeInTheDocument()
    expect(screen.getByText('Run the Website Audit again.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'https://shop.test/category/taps/basin-mixer-1' })).toBeInTheDocument()
  })

  it('says plainly when NXT Sales holds no link at all', () => {
    render(
      <PdpAssessmentPanel
        assessment={assessment({ case: 'no_link', issue: 'no_link', endPdpValue: null, url: null, finalUrl: null, httpStatus: null, suggestedProductUrls: [], headline: 'No End PDP link recorded' })}
        companyName="Acme"
      />,
    )
    expect(screen.getByText('No End PDP link')).toBeInTheDocument()
    expect(screen.getByText('Empty')).toBeInTheDocument()
  })
})

const enrichment = (): PdpEnrichment => ({
  status: 'ready',
  reason: null,
  generatedAt: '2026-09-15T00:00:00Z',
  model: 'm',
  source: { url: 'https://shop.test/p/1', productName: 'Basin Mixer', sku: null, price: '35', currency: 'EUR', availability: 'In Stock', images: [], observedFields: [], missingFields: [] },
  research: { attempted: true, note: null, sources: [] },
  enriched: {
    enrichedTitle: 'Basin Mixer Tap, Chrome',
    categoryPath: ['Plumbing', 'Taps'],
    industryLabel: 'Sanitaryware',
    keyTransformation: 'From a basic listing to a structured record.',
    executiveSummary: 'Buyers need specifications.',
    attributes: [
      { name: 'Product Name', value: 'Basin Mixer', source: 'page', sourceUrl: 'https://shop.test/p/1' },
      { name: 'Thread', value: 'G 1/2', source: 'manufacturer', sourceUrl: 'https://maker.test/p' },
      { name: 'Cartridge', value: 'Ceramic 35 mm', source: 'enriched', sourceUrl: null },
    ],
    documents: [{ title: 'Technical Data Sheet', url: null, source: 'recommended' }],
  },
  checks: { relabelledToEnriched: 0, droppedCommercial: 0, droppedClaimSentences: 0 },
})

describe('EnrichmentSummary', () => {
  it('counts every attribute by where it came from and labels each one', () => {
    render(<EnrichmentSummary enrichment={enrichment()} />)
    expect(screen.getByText('1 from their page')).toBeInTheDocument()
    expect(screen.getByText('1 from manufacturer pages')).toBeInTheDocument()
    expect(screen.getByText('1 AI-enriched')).toBeInTheDocument()
    expect(screen.getByText('AI-enriched')).toBeInTheDocument()
    expect(screen.getByText(/to be sourced/)).toBeInTheDocument()
  })

  it('shows the reason when no enriched record was produced', () => {
    render(<EnrichmentSummary enrichment={{ ...enrichment(), status: 'failed', enriched: null, reason: 'The model was unavailable.' }} />)
    expect(screen.getByText('The model was unavailable.')).toBeInTheDocument()
  })
})
