import { windowProblem, type WindowConfig } from './window.js'

// THE LIMITS, AND HOW THEY MAY BE RAISED (pure rules; the service stores the result).
//
// Starting point (approved): pilot 100 companies / 1,200 Gemini calls; then daily
// 25 companies / 300 calls. 50 companies / 600 calls only after usage and accuracy
// were reviewed. There is NO 100-a-day tier: it needs a separate approval and a code
// change (owner's decision 2026-11-04). An admin can LOWER any limit at any time;
// raising one beyond what was approved is refused here, not just on screen.

export const PILOT_SIZE = 100
export const PILOT_GEMINI_CEILING = 1200
export const START_DAILY_COMPANIES = 25
export const START_DAILY_CEILING = 300

/** Calls a deep (Gemini) research is expected to need; one is not started with fewer left. Measured in the pilot, then tuned. */
export const DEEP_RESEARCH_CALL_ESTIMATE = 12

export const SCALE_LEVELS = {
  50: { companies: 50, ceiling: 600 },
} as const
export type ScaleLevel = keyof typeof SCALE_LEVELS

export interface ApprovedMax {
  approvedMaxCompanies: number
  approvedMaxCeiling: number
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)

export interface LimitUpdate {
  dailyCompanyLimit?: number
  dailyGeminiCeiling?: number
  retryShare?: number
}

/** A change of the daily limits, checked against what was approved. */
export function checkLimitUpdate(approved: ApprovedMax, u: LimitUpdate): Checked<LimitUpdate> {
  const out: LimitUpdate = {}
  if (u.dailyCompanyLimit !== undefined) {
    if (!whole(u.dailyCompanyLimit) || u.dailyCompanyLimit < 1) return { ok: false, error: 'The daily company limit must be a whole number, at least 1.' }
    if (u.dailyCompanyLimit > approved.approvedMaxCompanies) {
      return { ok: false, error: `The daily company limit can be at most ${approved.approvedMaxCompanies} until a higher level is approved after review.` }
    }
    out.dailyCompanyLimit = u.dailyCompanyLimit
  }
  if (u.dailyGeminiCeiling !== undefined) {
    if (!whole(u.dailyGeminiCeiling) || u.dailyGeminiCeiling < 0) return { ok: false, error: 'The daily Gemini ceiling must be a whole number, 0 or more (0 = no Gemini research at all).' }
    if (u.dailyGeminiCeiling > approved.approvedMaxCeiling) {
      return { ok: false, error: `The daily Gemini ceiling can be at most ${approved.approvedMaxCeiling} calls until a higher level is approved after review.` }
    }
    out.dailyGeminiCeiling = u.dailyGeminiCeiling
  }
  if (u.retryShare !== undefined) {
    if (!whole(u.retryShare) || u.retryShare < 0 || u.retryShare > 50) return { ok: false, error: 'The retry share must be a whole number from 0 to 50 (percent of a night’s companies).' }
    out.retryShare = u.retryShare
  }
  return { ok: true, value: out }
}

/** Approving the one higher level (50 a day). Needs the approved pilot. Nothing above 50 exists. */
export function checkScaleApproval(state: ApprovedMax & { pilotApproved: boolean }, level: number): Checked<{ companies: number; ceiling: number }> {
  if (level !== 50) return { ok: false, error: 'The only higher level is 50 companies a day. Anything above needs a separate approval.' }
  if (!state.pilotApproved) return { ok: false, error: 'The pilot must be approved before any higher level.' }
  const target = SCALE_LEVELS[level]
  if (state.approvedMaxCompanies >= target.companies) return { ok: false, error: `${level} companies a day is already approved.` }
  return { ok: true, value: { companies: target.companies, ceiling: target.ceiling } }
}

export function checkWindow(w: WindowConfig): Checked<WindowConfig> {
  const problem = windowProblem(w)
  return problem ? { ok: false, error: problem } : { ok: true, value: { start: w.start.trim(), end: w.end.trim(), timezone: w.timezone.trim() } }
}
