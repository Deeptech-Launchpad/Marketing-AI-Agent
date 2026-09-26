import type { SignalCategory } from './types.js'

// HOW A SELLER COULD OPEN ON A SIGNAL.
//
// A signal card used to show a date and a sentence, and left the salesperson to
// work out what to do about it. That is a real gap — but the way it is closed
// matters more than that it is closed, because an outreach angle is the first
// thing in this engine that is about US rather than about THEM.
//
// Three rules follow from that, and they are the whole design:
//
//   1. IT IS COMPOSED, NEVER GENERATED. Every angle below is a fixed sentence
//      chosen by the signal's CATEGORY. No model writes one, so no angle can
//      quietly assert something the source never said — which is exactly the
//      failure mode of asking a model to "suggest an approach" while holding
//      a page full of the prospect's own claims.
//
//   2. IT NEVER RESTATES THE EVIDENCE AS FACT. The angles talk about what WE
//      would raise, not about what the company is doing. "Approach around
//      keeping product data complete as the range grows" is ours to say;
//      "their range is growing" is the source's to say, and it is already
//      said, verbatim, one field along.
//
//   3. IT CAN BE ABSENT. A category with no sensible opening returns null and
//      the card shows no angle. A generic line applied to everything would
//      read as advice while carrying none, and would train a reader to skip
//      the field on the occasions it is worth something.
//
// Nothing here knows a company name, an industry, a domain or a person. The
// input is a category and a job title that the SOURCE stated; the output is the
// same sentence for every company on earth that produced that category.

/**
 * The opening for each category of signal.
 *
 * Written as "approach around …" rather than "they need …" on purpose: the
 * first is a suggestion about a conversation, the second is a claim about a
 * company we have observed one page of.
 */
const BY_CATEGORY: Record<SignalCategory, string | null> = {
  // A published range, catalogue or product announcement.
  catalog:
    'Approach around keeping product information complete, structured and AI-discoverable as the catalogue grows.',
  // A hire, a team, an opening.
  hiring:
    'Approach around how much of a new hire’s first months go into cleaning and structuring existing product data.',
  // A platform, a CMS, a storefront technology.
  technology:
    'Approach around what the current storefront can and cannot publish as structured product data for search and AI answers.',
  // The company's own site, read directly.
  website:
    'Approach around what a buyer — or an answer engine — can and cannot find on the product pages as they stand today.',
  // Expansion, partnership, launch, market move.
  business:
    'Approach around keeping product information consistent and complete as the business expands into new lines or markets.',
  // Press and third-party coverage.
  news: 'Approach around how the catalogue supports what the company is publicly telling the market.',
  // A CRM record. Ours already, and not an opening in itself.
  crm: null,
}

/** Observations that something EXISTS or DESCRIBES itself — not events to open on. */
const NO_ANGLE_TYPE = /(^|_)(presence|description)(_|$)/

/**
 * The angle for one signal, or null when the category suggests none.
 *
 * `statedJobTitle` is used ONLY when a source explicitly published that title.
 * It is never derived from the fact that a page is a careers page, and never
 * from a company's industry — a role nobody advertised must not appear in a
 * sentence a salesperson is about to read out.
 */
export function outreachAngleFor(input: {
  category: SignalCategory
  /** A role title the SOURCE stated verbatim. Null when it stated none. */
  statedJobTitle?: string | null
  /**
   * The signal's polarity. A NEGATIVE signal (unreachable site, open deal,
   * suppression) is a reason not to approach, and a NEUTRAL one (a profile
   * exists, a description, a named person) is context rather than a reason —
   * neither gets an opening. Omitted means positive, for callers that only
   * produce positive events.
   */
  polarity?: 'positive' | 'negative' | 'neutral'
  /** The signal type, so presence/description observations never get an angle. */
  signalType?: string
}): string | null {
  if (input.polarity && input.polarity !== 'positive') return null
  if (input.signalType && NO_ANGLE_TYPE.test(input.signalType)) return null
  const title = input.statedJobTitle?.trim()
  if (input.category === 'hiring' && title) {
    // Quotes the advertised role back, because that is what the source
    // established. The clause after it is ours, and reads as ours.
    return (
      `The role “${title}” is publicly advertised — approach around how much of that role’s first months ` +
      'go into cleaning and structuring existing product data.'
    )
  }
  return BY_CATEGORY[input.category] ?? null
}
