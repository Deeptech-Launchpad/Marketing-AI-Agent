// Section-aware chunking with overlap.
//
// Token counts are approximated by characters/4 rather than a real tokeniser.
// That is a deliberate trade: a tokeniser dependency buys precision that only
// matters for billing, and billing here reads the provider's own reported
// counts. This number is used only to size chunks.

const TARGET_TOKENS = 800
const OVERLAP_TOKENS = 120
const CHARS_PER_TOKEN = 4

export interface Chunk {
  seq: number
  content: string
  tokenCount: number
  sectionPath: string | null
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Markdown-style headings become the section path carried on each chunk. */
function headingOf(line: string): string | null {
  const m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/)
  return m?.[2]?.trim() || null
}

/**
 * Splits on blank lines first so a chunk boundary lands between paragraphs
 * rather than mid-sentence, then packs paragraphs up to the target size with a
 * trailing overlap so a fact spanning a boundary is still retrievable.
 */
export function chunk(text: string): Chunk[] {
  const targetChars = TARGET_TOKENS * CHARS_PER_TOKEN
  const overlapChars = OVERLAP_TOKENS * CHARS_PER_TOKEN

  const blocks: Array<{ text: string; section: string | null }> = []
  let section: string | null = null

  for (const para of text.split(/\n\s*\n/)) {
    const trimmed = para.trim()
    if (!trimmed) continue
    const firstLine = trimmed.split('\n')[0] ?? ''
    const heading = headingOf(firstLine)
    if (heading) section = heading
    blocks.push({ text: trimmed, section })
  }

  const chunks: Chunk[] = []
  let buffer = ''
  let bufferSection: string | null = null
  let seq = 0

  const flush = () => {
    const content = buffer.trim()
    if (!content) return
    chunks.push({
      seq: seq++,
      content,
      tokenCount: estimateTokens(content),
      sectionPath: bufferSection,
    })
  }

  // Tracks whether the next block begins a new chunk. This cannot be inferred
  // from `buffer` being empty: after a flush the buffer is repopulated with the
  // overlap tail, so an `if (!buffer)` test never fires again and every chunk
  // after the first inherits the section of the very first block — which, for a
  // document that opens with anything other than a heading, is null. The
  // observable symptom was sectionPath being null on every chunk of every
  // document, which silently degrades citations to document-level only.
  let startingNewChunk = true

  for (const block of blocks) {
    if (buffer && buffer.length + block.text.length + 2 > targetChars) {
      flush()
      // Carry the tail of the previous chunk forward as overlap.
      buffer = buffer.length > overlapChars ? buffer.slice(-overlapChars) : buffer
      startingNewChunk = true
    }

    if (startingNewChunk) {
      bufferSection = block.section
      startingNewChunk = false
    } else if (bufferSection === null && block.section) {
      // The chunk began before any heading (a preamble, a banner, a lead
      // paragraph). Adopt the first heading it does reach, so the citation
      // points somewhere useful instead of nowhere.
      bufferSection = block.section
    }

    buffer = buffer ? `${buffer}\n\n${block.text}` : block.text
  }
  flush()

  // A single block longer than the target still has to be split, or it would
  // be dropped entirely by the packing loop above.
  return chunks.flatMap((c) => {
    if (c.content.length <= targetChars * 1.5) return [c]
    const parts: Chunk[] = []
    for (let i = 0; i < c.content.length; i += targetChars) {
      parts.push({
        seq: c.seq,
        content: c.content.slice(i, i + targetChars),
        tokenCount: estimateTokens(c.content.slice(i, i + targetChars)),
        sectionPath: c.sectionPath,
      })
    }
    return parts
  }).map((c, i) => ({ ...c, seq: i }))
}
