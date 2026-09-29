import { z } from 'zod'
import { env } from '../config/env.js'
import { getLlm } from '../llm/index.js'
import { logger } from '../platform/logger.js'

// READING A TEAM PAGE WITH A MODEL — AND PROVING IT READ RATHER THAN WROTE.
//
// The regex extractor in peopleExtraction.ts is precision-biased on purpose:
// it catches "Jane Smith, VP of Ecommerce" and misses "Jane heads up our
// ecommerce team, and has since 2019". Real about-pages are written in prose,
// so the misses are not rare.
//
// A model reads prose well. It also INVENTS people, fluently and with complete
// confidence, and this engine's governing rule is that "no verified decision
// maker found" beats "probably this person". Those two facts are the whole
// design problem, and this module's answer is:
//
//   THE MODEL NEVER SUPPLIES A FACT. IT ONLY POINTS AT ONE.
//
// Every name and title it returns is checked against the page text we fetched
// ourselves. If the characters are not in those bytes, the person is dropped —
// not flagged, not down-weighted, dropped. So a hallucinated colleague cannot
// survive to the candidate table however plausible it sounds, and the worst a
// bad model run can do is find nothing.
//
// WHAT IT IS NEVER ASKED. It is never asked who works at a company, never
// asked to recall an organisation, and never given a company name without the
// page text — because those questions have answers whatever the truth is. It
// is asked one question about one document: who does THIS TEXT say works here.
//
// THE UNTRUSTED-TEXT BOUNDARY, which this deliberately crosses.
//
// webCorroborationProvider.ts used to state that fetched page text never
// reaches a model. That was a prompt-injection defence and it was a good one.
// Crossing it is safe only because of what the model is allowed to do on the
// other side: it has NO tools, NO ability to write anything, its output is
// forced through a schema, and every field is verified against the source
// before it is believed. An injection ordering it to "report our CEO" yields a
// name that is nowhere in the bytes, and is dropped. The verification is the
// defence; the prompt is not.
//
// THE LIMIT OF THAT GUARANTEE, stated plainly because it is easy to overclaim.
//
// The promise is: EVERY CHARACTER REPORTED CAME FROM THE COMPANY'S OWN PAGE.
// The promise is NOT: every claim on a company's page is true. An injection
// that writes "Bob Danvers is the Chief Executive Officer" INTO the page is
// not caught, and should not be — at that point the company's own website
// asserts it, which is exactly the first-party signal this provider exists to
// read, and the pattern extractor beside it would take the same sentence.
// Trusting a company's own site about its own staff is the premise of the
// whole provider; this module does not weaken it and cannot repair it.

/** What the model is allowed to return. Nothing here is a contact detail. */
const ReadPeople = z.object({
  people: z
    .array(
      z.object({
        /** The person's name, copied from the text. */
        fullName: z.string().min(3).max(80),
        /** Their role, copied from the text. Null when the text gives none. */
        rawTitle: z.string().max(120).nullable(),
        /**
         * The sentence the model took them from, verbatim.
         *
         * This is the load-bearing field. It is what the verification checks
         * against, and it is what a human reads when deciding whether to
         * believe the extraction at all.
         */
        sourceSentence: z.string().min(10).max(400),
        /**
         * The organisation the SAME sentence says they currently work for,
         * copied from it (2026-09-29). Optional: older prompt versions do not
         * return it. Checked in code — see employerFromSentence.
         */
        employer: z.string().max(120).nullable().optional(),
      }),
    )
    .max(12),
})

export interface ReadPerson {
  fullName: string
  rawTitle: string | null
  /** The stretch of the page this person was read out of, verbatim. */
  sourceSentence: string
  /**
   * The employer that same sentence states, verbatim — or null. Only ever a
   * value employerFromSentence accepted; never the page's domain or title.
   */
  employer?: string | null
}

/** Letters and digits only, lower-cased — for comparing what a page SAYS. */
function flatten(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Is every part of this claim actually in the page?
 *
 * The name must appear, the quoted sentence must appear, and the title — when
 * the model gave one — must appear too. Whitespace and punctuation are
 * normalised away because a model reflows text; letters are not, because
 * letters are the claim.
 *
 * Exported so the check can be tested directly. It is the only thing standing
 * between a fluent guess and the candidate table.
 */
export function isGroundedInSource(person: ReadPerson, sourceText: string): boolean {
  const haystack = flatten(sourceText)
  if (haystack.length === 0) return false

  const name = flatten(person.fullName)
  if (name.length < 3 || !haystack.includes(name)) return false

  const quoted = flatten(person.sourceSentence)
  if (quoted.length < 8 || !haystack.includes(quoted)) return false

  // The name and the title must be bound by the SAME quoted sentence. Checking
  // each against the whole page let a model pair one person's name with
  // another person's title, both of which the page does contain.
  if (!quoted.includes(name)) return false

  if (person.rawTitle) {
    const title = flatten(person.rawTitle)
    if (title.length < 2 || !quoted.includes(title)) return false
  }
  return true
}

/** Words that turn "X at Acme" into a PAST job, which ties X to nobody now. */
const FORMER_ROLE = /\b(former|formerly|previously|ex-|prior to (joining|that)|until (19|20)\d\d|retired|departed|stepped down|left the company)\b/i

/**
 * The employer a verified person's own sentence states, or null.
 *
 * Accepted only when every character of it is in that sentence (so the page,
 * not the model, says it), and the sentence does not describe a former role.
 * A rejected employer drops the EMPLOYER, never the person: the name and title
 * were already verified, and the engine's company-match step then treats the
 * link as unproven, exactly as before this field existed.
 */
export function employerFromSentence(person: { sourceSentence: string; employer?: string | null }): string | null {
  const employer = person.employer?.trim()
  if (!employer) return null
  const e = flatten(employer)
  if (e.length < 2 || !flatten(person.sourceSentence).includes(e)) return null
  if (FORMER_ROLE.test(person.sourceSentence)) return null
  return employer
}

export interface ModelReadResult {
  people: ReadPerson[]
  /** Claims the model made that the page did not support. Counted, never used. */
  rejected: number
  /** Why no reading happened, when none did. */
  reason: string | null
  /**
   * True only when a read was ATTEMPTED and failed (the model call threw). A
   * reader that is switched off, or a page with too little text, is not a
   * failure. Callers use this so a failed read is never reported as "the page
   * named nobody".
   */
  failed: boolean
  model: string | null
  costUsd: number
}

const EMPTY: ModelReadResult = { people: [], rejected: 0, reason: null, failed: false, model: null, costUsd: 0 }

/**
 * Reads one already-fetched page for people it explicitly names.
 *
 * `text` must be text this service fetched itself. Nothing here fetches, and
 * nothing here accepts a URL: the caller owns the transport, so the SSRF
 * guard, the byte cap and the timeouts are all already applied by the time
 * this is reached.
 */
export async function readPeopleFromPage(input: {
  text: string
  sourceUrl: string
  tenantId: string
}): Promise<ModelReadResult> {
  if (!env.DM_MODEL_READER_ENABLED) {
    return { ...EMPTY, reason: 'DM_MODEL_READER_ENABLED is off, so no page was read by a model.' }
  }

  // Bounded: one page's worth. A model asked to read a whole site is a model
  // asked to summarise, and summarising is where invention starts.
  const text = input.text.slice(0, 12_000).trim()
  if (text.length < 80) {
    return { ...EMPTY, reason: 'The page carried too little text to read.' }
  }

  try {
    const result = await getLlm().generate({
      promptKey: 'decisionmaker.read_people',
      variables: { pageText: text, sourceUrl: input.sourceUrl },
      schema: ReadPeople,
      feature: 'decision_maker_page_read',
      tenantId: input.tenantId,
    })

    const claimed = result.data.people
    const grounded = claimed
      .filter((p) => isGroundedInSource(p, text))
      .map((p) => ({ fullName: p.fullName, rawTitle: p.rawTitle, sourceSentence: p.sourceSentence, employer: employerFromSentence(p) }))

    return {
      people: grounded,
      rejected: claimed.length - grounded.length,
      reason: null,
      failed: false,
      model: result.model,
      costUsd: result.costUsd,
    }
  } catch (err) {
    // A model failure is a source failure, reported like any other. It must
    // never fail the run: the regex pass has already produced whatever it
    // produced, and losing that because a model call timed out would make the
    // engine worse than not having one.
    logger.info(
      { err: (err as Error).message, sourceUrl: input.sourceUrl },
      'model page read failed; pattern extraction stands',
    )
    return { ...EMPTY, failed: true, reason: `The model could not read this page: ${(err as Error).message}` }
  }
}
