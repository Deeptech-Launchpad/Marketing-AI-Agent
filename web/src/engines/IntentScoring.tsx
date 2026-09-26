import { EnginePage } from '../components/shell/EnginePage'
import { LockedEngine } from '../components/ui/LockedEngine'

// Intent Scoring (#984) — LOCKED FOR THE CURRENT PHASE.
//
// The engine is untouched. Its policy, its decay bands, its contributions, its
// snapshots, its recalculation endpoint and every stored score still exist and
// still run; nothing about the backend changed. What is withheld is this
// screen.
//
// WHY. The scoring weights are a PROVISIONAL DEFAULT that the business has not
// signed off. The screen said so honestly — it carried a "Provisional weights"
// chip and a blocked notice quoting the policy — and it still showed a 100 of
// 100 ring, a HIGH level, a raw total of 138, a set-aside count of 709 and a
// history of past scores. In a demo the ring is what gets read; the caveat
// underneath it does not. An unapproved number presented with that much
// confidence invites one question nobody can currently answer: what does a
// single point mean?
//
// WHAT THE LOCK HAD TO BE, RATHER THAN A HIDDEN RENDER.
//
// Every fetch on this screen is deleted, not conditioned:
//
//   /intent-score/companies/:id/breakdown
//   /intent-score/companies/:id/history
//   /intent-score/policies/v1-provisional
//   POST /intent-score/recalculate
//
// A screen that still requested the breakdown and declined to draw it could
// leak the score through a loading skeleton, an error message quoting the
// response body, the footer completion strip ("Intent score recorded — 100 of
// 100, HIGH"), or a devtools network tab open on a projector. None of those
// paths exists any more, because the data never arrives.
//
// The Recalculate action is gone for the same reason: it is a write that
// produces exactly the value being withheld.
//
// TO UNLOCK: restore this file from version control once the weights are
// approved. Nothing else has to be put back.

export function IntentScoring() {
  return (
    <EnginePage engineId="scoring">
      <LockedEngine detail="Intent scoring is currently locked while the core pipeline engines are being validated." />
    </EnginePage>
  )
}
