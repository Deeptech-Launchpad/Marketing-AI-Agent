import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProductPageMock } from './ProductPageMock'
import type { EnrichedRecord } from '../../lib/types'

// ILLUSTRATIVE EXAMPLES BELONG TO THE AFTER VIEW ONLY.
//
// The BEFORE view is the customer's page as it is today, and nothing may be
// added to it. The AFTER view fills the gaps with labelled examples of what a
// finished field looks like — so the improvement is visible — and every one of
// them carries the EXAMPLE label and the note that it is not their data.

const field = (over: Record<string, unknown>) => ({
  group: 'identity',
  before: null,
  after: null,
  state: 'absent',
  method: null,
  sourcePath: null,
  sourceUrl: 'https://acme.test/p/1',
  derivedAttributes: [],
  recommendation: 'Publish it as its own field.',
  ...over,
})

const RECORD = {
  crmCompanyId: 'co-1',
  auditRunId: 'run-1',
  pageId: 'p1',
  sourceUrl: 'https://acme.test/p/1',
  pageContext: { pageTitle: 'Pump 42', siteName: 'Acme', breadcrumbs: 'Home > Pumps', host: 'acme.test' },
  title: 'Pump 42',
  imageUrl: null,
  fields: [
    field({ field: 'product.name', label: 'Product name', before: 'Pump 42', after: 'Pump 42', state: 'observed' }),
    field({ field: 'product.brand', label: 'Brand', before: 'ACME', after: 'ACME', state: 'observed' }),
    field({ field: 'product.gtin', label: 'GTIN / barcode' }),
    field({ field: 'product.dimensions', label: 'Dimensions' }),
  ],
  observedCount: 2,
  restructuredCount: 0,
  absentCount: 2,
  derivedAttributeCount: 0,
  beforeSummary: 'b',
  afterSummary: 'a',
  keyTransformation: 'k',
} as unknown as EnrichedRecord

const EXAMPLES = {
  'product.gtin': { value: '[13-digit GTIN / EAN barcode]', kind: 'format' as const },
  'product.dimensions': { value: '300 × 200 × 150 mm', kind: 'sample' as const },
}

const openAfter = async () => {
  const user = userEvent.setup()
  await user.click(screen.getByRole('tab', { name: /enhanced/i }))
}

describe('examples in the product page mock', () => {
  it('shows none on the BEFORE view, which is the customer’s page today', () => {
    render(<ProductPageMock record={RECORD} examples={EXAMPLES} />)
    expect(screen.queryByText('300 × 200 × 150 mm')).toBeNull()
    expect(screen.queryByText('[13-digit GTIN / EAN barcode]')).toBeNull()
    expect(screen.queryByText(/product photography goes here/i)).toBeNull()
  })

  it('fills the gaps on the AFTER view, each one labelled', async () => {
    const { container } = render(<ProductPageMock record={RECORD} examples={EXAMPLES} />)
    await openAfter()
    expect(screen.getByText('300 × 200 × 150 mm')).toBeInTheDocument()
    expect(screen.getByText('[13-digit GTIN / EAN barcode]')).toBeInTheDocument()

    const examples = container.querySelectorAll('.ppm__example')
    expect(examples.length).toBe(2)
    for (const ex of examples) {
      expect(within(ex as HTMLElement).getByText('Example')).toBeInTheDocument()
      expect(within(ex as HTMLElement).getByText(/not your product data/i)).toBeInTheDocument()
    }
  })

  it('keeps the honest "not published" statement beside every example', async () => {
    render(<ProductPageMock record={RECORD} examples={EXAMPLES} />)
    await openAfter()
    expect(screen.getAllByText('Not published on current website').length).toBeGreaterThanOrEqual(2)
  })

  it('shows where product photography goes when there is no image — labelled, never a photo', async () => {
    const { container } = render(<ProductPageMock record={RECORD} examples={EXAMPLES} />)
    await openAfter()
    const frame = container.querySelector('.ppm__img--example') as HTMLElement
    expect(frame).not.toBeNull()
    expect(within(frame).getByText('Example')).toBeInTheDocument()
    expect(within(frame).queryByRole('img')).toBeNull()
  })

  it('adds no example to a field the page actually published', async () => {
    render(<ProductPageMock record={RECORD} examples={{ ...EXAMPLES, 'product.brand': { value: 'SHOULD NOT SHOW', kind: 'format' } }} />)
    await openAfter()
    expect(screen.queryByText('SHOULD NOT SHOW')).toBeNull()
  })

  it('renders without examples exactly as before', async () => {
    const { container } = render(<ProductPageMock record={RECORD} />)
    await openAfter()
    expect(container.querySelectorAll('.ppm__example').length).toBe(0)
  })
})
