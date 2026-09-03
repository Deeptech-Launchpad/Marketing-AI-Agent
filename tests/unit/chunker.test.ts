import { describe, expect, it } from 'vitest'
import { chunk, estimateTokens } from '../../src/knowledge/chunker.js'

// Section tracking has its own describe block because it regressed silently:
// sectionPath was null on every chunk of every document, and nothing failed —
// citations simply degraded to document-level with no signal that anything was
// wrong.

const heading = (n: string) => `## ${n}`
const para = (n: string, len = 600) => `${n} `.repeat(Math.ceil(len / (n.length + 1)))

describe('chunk', () => {
  it('returns a single chunk for short input', () => {
    const out = chunk('# Title\n\nA short paragraph.')
    expect(out).toHaveLength(1)
    expect(out[0]!.content).toContain('A short paragraph.')
  })

  it('splits long input into multiple chunks with sequential seq', () => {
    const doc = ['# Doc', para('alpha', 2000), para('beta', 2000), para('gamma', 2000)].join('\n\n')
    const out = chunk(doc)
    expect(out.length).toBeGreaterThan(1)
    expect(out.map((c) => c.seq)).toEqual(out.map((_, i) => i))
  })

  it('ignores empty input', () => {
    expect(chunk('')).toEqual([])
    expect(chunk('   \n\n  ')).toEqual([])
  })

  it('splits a single oversized block rather than dropping it', () => {
    // One paragraph with no blank lines, far past the target size.
    const out = chunk('x'.repeat(20_000))
    expect(out.length).toBeGreaterThan(1)
    expect(out.reduce((s, c) => s + c.content.length, 0)).toBeGreaterThan(15_000)
  })
})

describe('sectionPath', () => {
  it('attaches the heading a chunk starts under', () => {
    const out = chunk(['# Doc', heading('First'), 'Short body.'].join('\n\n'))
    expect(out[0]!.sectionPath).toBe('Doc')
  })

  it('advances the section across chunk boundaries', () => {
    const doc = [
      '# Doc',
      heading('Alpha'),
      para('alpha', 2600),
      heading('Beta'),
      para('beta', 2600),
      heading('Gamma'),
      para('gamma', 2600),
    ].join('\n\n')

    const sections = chunk(doc).map((c) => c.sectionPath)
    // The regression this guards: every entry was null.
    expect(sections.every((s) => s === null)).toBe(false)
    expect(new Set(sections.filter(Boolean)).size).toBeGreaterThan(1)
    expect(sections).toContain('Gamma')
  })

  it('adopts the first heading when a document opens with non-heading text', () => {
    // Matches the fixture shape: a blockquote banner before the H1.
    const doc = ['> TEST DATA banner line.', '# Real Title', 'Body text.'].join('\n\n')
    expect(chunk(doc)[0]!.sectionPath).toBe('Real Title')
  })

  it('leaves sectionPath null when the document has no headings at all', () => {
    expect(chunk('Just a paragraph.\n\nAnd another.')[0]!.sectionPath).toBeNull()
  })
})

describe('estimateTokens', () => {
  it('approximates by characters, never returning zero for real text', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('a'.repeat(4000))).toBe(1000)
  })
})
