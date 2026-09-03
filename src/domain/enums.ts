// Shared vocabulary. String unions rather than Prisma enums so a value can be
// added without a migration, matching how NXT Sales keeps status/stage columns
// as plain strings.

export const RUN_STATUS = [
  'queued',
  'running',
  'awaiting_approval',
  'completed',
  'failed',
  'cancelled',
] as const
export type RunStatus = (typeof RUN_STATUS)[number]

export const STEP_TYPES = [
  'INTAKE',
  'ICP_SYNTHESIS',
  'SEGMENT_PROPOSE',
  'SEGMENT_RESOLVE',
  'RESEARCH',
  'STRATEGY',
  'APPROVAL_STRATEGY',
  'CONTENT_GENERATE',
  'CONTENT_VALIDATE',
  'APPROVAL_CONTENT',
  'PACKAGE',
] as const
export type StepType = (typeof STEP_TYPES)[number]

export const STEP_STATUS = ['running', 'completed', 'failed', 'awaiting_approval'] as const
export type StepStatus = (typeof STEP_STATUS)[number]

export const APPROVAL_KINDS = ['strategy', 'content'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export const APPROVAL_STATUS = [
  'pending',
  'approved',
  'rejected',
  'changes_requested',
  'expired',
] as const
export type ApprovalStatus = (typeof APPROVAL_STATUS)[number]

// Phase 1 declares all three classes but the dispatcher rejects everything that
// is not `read`. The classes exist now so the gate is already in place when
// write tools arrive.
export const SIDE_EFFECT_CLASSES = ['read', 'write_internal', 'write_external'] as const
export type SideEffectClass = (typeof SIDE_EFFECT_CLASSES)[number]

export const CORPUS_TYPES = [
  'product_service',
  'company_info',
  'brand_guidelines',
  'past_campaign',
  'case_study',
  'marketing_content',
  'persona',
] as const
export type CorpusType = (typeof CORPUS_TYPES)[number]

// Channels a campaign can PLAN and GENERATE content for. Publishing to any of
// them is out of Phase 1 scope entirely — there is no channel adapter.
export const CHANNELS = ['email', 'linkedin', 'meta', 'generic'] as const
export type Channel = (typeof CHANNELS)[number]

export const ASSET_TYPES = [
  'post',
  'ad_copy',
  'email_body',
  'subject_line',
  'landing_copy',
] as const
export type AssetType = (typeof ASSET_TYPES)[number]

export const MEMBER_ROLES = ['viewer', 'operator', 'approver', 'admin'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

export const PERMISSIONS = ['view', 'operate', 'approve', 'admin'] as const
export type Permission = (typeof PERMISSIONS)[number]

// `approve` is deliberately NOT granted to `operator`: whoever runs a campaign
// should not be the one who signs it off.
export const ROLE_PERMISSIONS: Record<MemberRole, readonly Permission[]> = {
  viewer: ['view'],
  operator: ['view', 'operate'],
  approver: ['view', 'approve'],
  admin: ['view', 'operate', 'approve', 'admin'],
}
