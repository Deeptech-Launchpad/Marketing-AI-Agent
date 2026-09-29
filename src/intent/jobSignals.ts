// JOB POSTINGS ARE NOT INTENT SIGNALS (2026-09-28).
//
// Sales decided that a company hiring — a careers-page role, a job-board
// posting, a "we're hiring" post, a recruitment page — is not to be used as an
// intent signal. This is the one definition of "a job signal", used both to
// stop them being collected and to keep ones stored by earlier runs off the
// screen. Every other signal type is untouched.

/** Every signal type a source produced for hiring. */
export const JOB_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  'careers_page_role', // the company's own careers page
  'relevant_job_posting', // job boards
  'public_job_posting', // a job posting found by open-web research
  'external_hiring', // a forum / news / social page stating the company is hiring
  'social_post_hiring', // a public social post matched to the "Hiring" theme
])

/** True for a hiring / job-posting signal, by its category or its type. */
export function isJobSignal(s: { signalType?: string | null; signalCategory?: string | null }): boolean {
  return s.signalCategory === 'hiring' || (s.signalType != null && JOB_SIGNAL_TYPES.has(s.signalType))
}
