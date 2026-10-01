import type { ManualSection } from './manualTypes'
import { ENRICHMENT, GETTING_STARTED, INTENT_SIGNALS, PROSPECTS } from './manualStart'
import { DECISION_MAKERS, OUTREACH, SEVERAL_COMPANIES, TROUBLESHOOTING } from './manualOutreach'

// The User Manual, in the order a first-time user works through the
// application. Opened from the Help icon in the top bar (/help).
export const MANUAL: ManualSection[] = [
  GETTING_STARTED,
  PROSPECTS,
  ENRICHMENT,
  INTENT_SIGNALS,
  DECISION_MAKERS,
  OUTREACH,
  SEVERAL_COMPANIES,
  TROUBLESHOOTING,
]
