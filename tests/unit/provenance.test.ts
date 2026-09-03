import { describe, expect, it } from 'vitest'
import { claim, renderClaims, PROVENANCE_LABEL } from '../../src/domain/provenance.js'

describe('provenance labelling', () => {
  it('strips a label the model already applied, so it is never doubled', () => {
    // Observed in a real run: the safety preamble asks the model to label its
    // claims, and the code labels again -> "[AI inference] [AI inference] ...".
    expect(claim('ai_inference', '[AI inference] Supplies pipeline components.').statement).toBe(
      'Supplies pipeline components.',
    )
    expect(claim('crm_data', '[CRM data] 4913 companies matched.').statement).toBe('4913 companies matched.')
  })

  it('leaves an unlabelled statement untouched', () => {
    expect(claim('user_intent', 'Concept requested: infrastructure').statement).toBe(
      'Concept requested: infrastructure',
    )
  })

  it('strips labels from the NXT Sales convention too', () => {
    expect(claim('research', '[Page data] Observed on the site.').statement).toBe('Observed on the site.')
  })

  it('renders exactly one label per claim', () => {
    const rendered = renderClaims([claim('ai_inference', '[AI inference] x'), claim('crm_data', 'y')])
    expect(rendered).toEqual(['[AI inference] x', '[CRM data] y'])
    expect(rendered[0]!.match(/\[AI inference\]/g)).toHaveLength(1)
  })

  it('covers all five required labels', () => {
    expect(Object.values(PROVENANCE_LABEL)).toEqual([
      '[User intent]',
      '[CRM data]',
      '[Knowledge]',
      '[Research]',
      '[AI inference]',
    ])
  })
})
