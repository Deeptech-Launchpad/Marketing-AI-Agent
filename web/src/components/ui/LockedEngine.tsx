import { Lock } from 'lucide-react'

// ONE PLACE THAT SAYS "NOT THIS PHASE".
//
// Intent Scoring, Sales Qualification and CRM Handoff are locked for the
// current demo phase. Their engines, queues, policies, stored results and
// APIs are all untouched and still run — what is withheld is the
// PRESENTATION.
//
// The reason is not that the numbers are wrong. It is that they are not
// business-approved: the scoring weights are a provisional default and the
// qualification threshold is a provisional threshold, and a provisional
// number shown beside observed facts reads as a finding of the same standing.
// In a live demo "100 of 100, HIGH" invites exactly one question — what does
// one point mean? — that nobody can currently answer.
//
// WHAT A LOCK HAS TO GUARANTEE
//
// Not showing a value is not the same as not having it. A screen that fetches
// a score and then declines to render it can still leak it through a loading
// skeleton, an error message quoting the response, a completion strip in the
// footer, or a devtools network tab open on a projector. So a locked screen
// makes NO REQUEST for the thing it is locking: the component below is the
// entire body, and the fetch is deleted rather than hidden behind a flag.
//
// One component so all three read identically. Three hand-written empty
// states drift, and drift reads as three different situations.

export const LOCKED_HEADLINE = 'Coming in the next phase'

/**
 * The whole body of a locked engine screen.
 *
 * `detail` is the engine-specific second line. It says what is locked and
 * why, and never what the value would have been.
 */
export function LockedEngine({ detail }: { detail: string }) {
  return (
    <div className="locked" data-testid="locked-engine">
      <Lock size={22} className="locked__icon" aria-hidden="true" />
      <p className="locked__title">{LOCKED_HEADLINE}</p>
      <p className="locked__detail">{detail}</p>
    </div>
  )
}
