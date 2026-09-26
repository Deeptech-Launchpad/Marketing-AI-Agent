import { EnginePage } from '../components/shell/EnginePage'
import { LockedEngine } from '../components/ui/LockedEngine'

// Human Approval (#980) — LOCKED FOR THE CURRENT PHASE.
//
// The engine is untouched. Its approval events, its report gate and every API
// it exposes still exist and still run; nothing about the backend changed.
// What is withheld is this screen.
//
// WHY. The CEO's 2026-09-24 direction moves the pipeline to Gemini-led
// prospect discovery, Intent Signals and Direct Outreach; Website Audit,
// Audit Report, Human Approval and AI Workbench are dropped for now. Outreach
// no longer gates on this approval (see src/outreach/engine.ts) — it gates on
// Decision Makers + Intent Signals instead.
//
// WHAT THE LOCK HAD TO BE, RATHER THAN A HIDDEN RENDER. Every fetch on this
// screen is deleted, not conditioned, so nothing can leak through a loading
// skeleton, an error message, the footer completion strip, or a devtools
// network tab open on a projector.
//
// TO UNLOCK: restore this file from version control. Nothing else has to be
// put back.

export function Approval() {
  return (
    <EnginePage engineId="approval" completion={{ done: false, nextTo: '/outreach' }}>
      <LockedEngine detail="Human Approval is locked while the platform moves to Gemini-led prospect discovery and direct outreach. Nothing here has been deleted." />
    </EnginePage>
  )
}
