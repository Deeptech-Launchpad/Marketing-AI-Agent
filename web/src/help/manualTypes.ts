// THE SHAPE OF THE USER MANUAL (2026-10-01).
//
// The manual is plain data, rendered by UserManual.tsx. Keeping the words out
// of the component means a non-developer can correct a sentence without
// touching layout code, and a test can check every required section exists.

/** One piece of content inside a section, in reading order. */
export type Block =
  /** An ordinary paragraph. */
  | { kind: 'text'; text: string }
  /** A small heading inside a section ("What it is", "What to do next"…). */
  | { kind: 'heading'; text: string }
  /** Numbered steps the reader follows in order. */
  | { kind: 'steps'; items: string[] }
  /** Unnumbered points. */
  | { kind: 'list'; items: string[] }
  /** A name and what it means — a field, a button, a status. */
  | { kind: 'terms'; items: Array<{ term: string; meaning: string }> }
  /** A worked example, set apart from the instructions. */
  | { kind: 'example'; title?: string; text: string }
  /** Something worth noticing. */
  | { kind: 'tip'; text: string }
  /** Something that can go wrong if missed. */
  | { kind: 'warning'; text: string }

export interface ManualSection {
  /** Used in the address bar: /help#prospects */
  id: string
  title: string
  /** One sentence shown under the title and in the contents list. */
  summary: string
  blocks: Block[]
}
