import type { SyncResource } from './types.js'

// TASK #986 — the field map, in ONE place.
//
// Mapping logic is not allowed to spread through the service. Everything that
// says "our field X becomes their field Y" lives here, is versioned, and is
// recorded on every sync result — so a handoff from last month can still be
// read against the map that produced it after the CRM schema moves on.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS MAP IS PROVISIONAL.
//
// It encodes decisions nobody has taken yet: whether a qualified lead should
// become a Company, a Deal or an Activity in NXT Sales; which field should
// hold an intent score; whether audit findings belong in a note or an
// activity. Those are listed in `OPEN_DECISIONS` below and reported by the API
// rather than quietly assumed.
//
// What forced the ambiguity is real and worth stating: NXT Sales has NO Lead
// object and NO Task object. Its models are Company, Deal, Activity, User and
// CallLog. And it has no custom fields on Company at all — only two, both on
// Deal — so there is currently nowhere structured to put a score.
// ─────────────────────────────────────────────────────────────────────────────

export const MAPPING_VERSION = 'crm-map-1'
export const PAYLOAD_VERSION = 'crm-payload-1'

export interface FieldMapping {
  /** Where the value comes from in the Marketing AI platform. */
  source: string
  /** Where it would go in NXT Sales. */
  target: string
  /** Which CRM object the target belongs to. */
  resource: SyncResource
  /** Whether a write would create, update, or is not yet possible. */
  disposition: 'write' | 'read_only_reference' | 'blocked_no_target_field'
  note?: string
}

/**
 * The map itself.
 *
 * `blocked_no_target_field` is used honestly and often: NXT Sales has no field
 * for most of what this platform knows, and pretending otherwise would produce
 * a payload that cannot be delivered.
 */
export const FIELD_MAP: FieldMapping[] = [
  // ── Company ─────────────────────────────────────────────────────────────
  {
    source: 'payload.company.crmCompanyId',
    target: 'Company.id',
    resource: 'company',
    disposition: 'read_only_reference',
    note: 'The company already exists in NXT Sales; this lead is about it. Nothing here creates a duplicate company.',
  },
  { source: 'payload.company.name', target: 'Company.name', resource: 'company', disposition: 'read_only_reference' },
  { source: 'payload.company.website', target: 'Company.endPdpUrl', resource: 'company', disposition: 'read_only_reference' },
  { source: 'payload.company.domain', target: 'Company.domain', resource: 'company', disposition: 'read_only_reference' },
  { source: 'payload.company.industry', target: 'Company.industry', resource: 'company', disposition: 'read_only_reference' },
  { source: 'payload.company.country', target: 'Company.country', resource: 'company', disposition: 'read_only_reference' },

  // ── The qualification itself ────────────────────────────────────────────
  {
    source: 'payload.qualification.status',
    target: 'Company.leadStatus',
    resource: 'company',
    disposition: 'blocked_no_target_field',
    note: 'DELIBERATELY BLOCKED. Company.leadStatus is the dropdown NXT Sales uses for its OWN pipeline, maintained by salespeople. The qualification status goes to the dedicated qualificationStatus custom field instead, so an automated score never reclassifies a record a person owns.',
  },
  {
    source: 'payload.intent.score',
    target: 'Company.customField:intentScore',
    resource: 'company',
    disposition: 'write',
    note: 'CONFIRMED on the live Company record: "Intent Score", type Number, key intentScore, enabled. The score is written as an integer 0-100. Absent from the local restored snapshot, which predates the field.',
  },
  {
    source: 'payload.qualification.status',
    target: 'Company.customField:qualificationStatus',
    resource: 'company',
    disposition: 'write',
    note: 'CONFIRMED on the live Company record: "Qualification Status", type DROPDOWN, key qualificationStatus, enabled. Because it is a dropdown, the internal status is translated to a configured option label before sending — NXT Sales rejects an unlisted value with a 400.',
  },
  {
    source: 'payload.qualification.reason',
    target: 'Activity.notes',
    resource: 'activity',
    disposition: 'blocked_no_target_field',
    note: 'PROVISIONAL. An Activity is the closest NXT Sales object to "something happened with this account", but whether qualification belongs there is a business decision.',
  },

  // ── Follow-up ───────────────────────────────────────────────────────────
  {
    source: 'payload.followUp.taskRef',
    target: 'Activity',
    resource: 'task',
    disposition: 'blocked_no_target_field',
    note: 'NXT Sales has no Task object. A follow-up would have to become an Activity, which does not carry a due date or an assignee in the same way.',
  },
  {
    source: 'payload.followUp.ownerCrmUserId',
    target: 'Company.ownerId',
    resource: 'company',
    disposition: 'blocked_no_target_field',
    note: 'PROVISIONAL and deliberately blocked. Setting an account owner from an automated qualification would reassign accounts, which is a sales-management decision.',
  },

  // ── Evidence ────────────────────────────────────────────────────────────
  {
    source: 'payload.audit.topFindings',
    target: 'Activity.notes',
    resource: 'note',
    disposition: 'blocked_no_target_field',
    note: 'PROVISIONAL. Findings are sample-scoped sentences; whether they belong as an activity, a note or an attachment is undecided.',
  },
  {
    source: 'payload.workbench.publicUrl',
    target: 'Company.linkedProfiles',
    resource: 'company',
    disposition: 'blocked_no_target_field',
    note: 'PROVISIONAL. The Workbench link is a bearer credential — anyone holding it can open the demonstration. Storing it in a shared CRM field needs an explicit decision.',
  },
  {
    source: 'payload.engagement.summary',
    target: 'Activity.notes',
    resource: 'note',
    disposition: 'blocked_no_target_field',
    note: 'PROVISIONAL. Engagement is summarised rather than event-by-event, to avoid filling the CRM with page views.',
  },
]

/**
 * Decisions this map cannot make on its own.
 *
 * Surfaced by the API so they are visible rather than buried in a comment.
 */
export const OPEN_DECISIONS: string[] = [
  'Should a qualified lead create a new NXT Sales object at all, or only annotate the Company that already exists? Every company in this pipeline is already a Company record.',
  'NXT Sales has no Lead object and no Task object. Should a qualified lead become a Deal, an Activity, or neither?',
  'Which field should hold the intent score? There are no custom fields on Company today, so one would have to be defined.',
  'Should Company.leadStatus be driven by automated qualification, or left to the salespeople who maintain it?',
  'Should audit findings be written as an Activity, a note, or an attachment?',
  'Should the Workbench public link be stored in the CRM? It is a bearer credential.',
  'Should engagement be summarised (current default) or synced event by event?',
  'Should the follow-up task be created in NXT Sales as an Activity, or stay in the Marketing AI platform?',
  'Should an automated qualification ever set Company.ownerId?',
  'What external key should the CRM store for deduplication? This engine proposes the qualification correlation key.',
]

/**
 * The correlation key a CRM record would carry.
 *
 * Stable across retries and redeliveries, and scoped by tenant so two tenants
 * that share a company id can never collide.
 */
export function externalKey(tenantId: string, crmCompanyId: string, qualificationId: string): string {
  return `mai:${tenantId}:${crmCompanyId}:${qualificationId}`
}

/** Mappings that could actually be written today. Currently none. */
export function writableMappings(): FieldMapping[] {
  return FIELD_MAP.filter((m) => m.disposition === 'write')
}

export function blockedMappings(): FieldMapping[] {
  return FIELD_MAP.filter((m) => m.disposition === 'blocked_no_target_field')
}
