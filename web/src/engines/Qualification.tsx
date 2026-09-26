import { EnginePage } from '../components/shell/EnginePage'
import { LockedEngine } from '../components/ui/LockedEngine'

// Sales Qualification (#985) — LOCKED FOR THE CURRENT PHASE.
//
// The engine is untouched. Threshold evaluation, owner resolution, the alert
// and follow-up actions, the append-only transition history and the
// qualification policy all still exist and still run. What is withheld is this
// screen.
//
// WHY. The threshold is a PROVISIONAL THRESHOLD, measured against a score
// whose weights are also provisional — so the verdict is two unapproved
// numbers compared with each other. The screen rendered that as a large
// HIGH-INTENT badge over "100 vs 70, +30 above the threshold", which is the
// most quotable thing on the whole pipeline and the least defensible.
//
// WHAT THE LOCK HAD TO BE, RATHER THAN A HIDDEN RENDER.
//
// Every fetch on this screen is deleted, not conditioned:
//
//   /sales-qualification/companies/:id
//   /sales-qualification/:id
//   /sales-qualification/companies/:id/history
//   /sales-qualification/policies/sq1-provisional
//   POST /sales-qualification/evaluate
//   POST /sales-qualification/:id/retry-actions
//
// A screen that still read the qualification and declined to draw it could
// leak the verdict through a loading line ("Comparing the intent score to the
// threshold"), an error quoting the response, or the owner-resolution notice.
// None of those paths exists any more.
//
// The Evaluate and Retry handoff actions are gone because both are writes that
// produce exactly the decision being withheld.
//
// TO UNLOCK: restore this file from version control once the threshold is
// approved. Nothing else has to be put back.

export function Qualification() {
  return (
    <EnginePage engineId="qualification">
      <LockedEngine detail="Sales qualification is currently locked while the core pipeline engines are being validated." />
    </EnginePage>
  )
}
