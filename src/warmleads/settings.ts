import { warmLeadsKeyProblem } from '../llm/gemini/apiKey.js'
import type { WarmLeadSettings } from '@prisma/client'
import { env } from '../config/env.js'
import { audit } from '../platform/audit.js'
import { prisma } from '../platform/db.js'
import { BadRequestError, ConflictError } from '../platform/errors.js'
import { checkLimitUpdate, checkScaleApproval, checkWindow, type LimitUpdate } from './limits.js'

// THE CONTROLS - every gate is enforced here, in the service, and not only by the screen.
//
//   start / pause     pause is the safe default; start needs something to do
//   limits            raised only up to what an admin approved after review (limits.ts)
//   window            23:00-06:00 Asia/Kolkata by default; an admin may change it
//   pilot approval    required before daily processing (pilot.ts)
//   scale approval    25 -> 50 a day, after review (nothing above 50 exists)
//   NXT Sales sync    its own approval, and the server's WARM_LEADS_SYNC_ENABLED must also be on

export async function ensureSettings(tenantId: string): Promise<WarmLeadSettings> {
  return prisma.warmLeadSettings.upsert({ where: { tenantId }, create: { tenantId }, update: {} })
}

async function change(tenantId: string, by: string, data: Partial<WarmLeadSettings>, action: string, summary: string): Promise<WarmLeadSettings> {
  await ensureSettings(tenantId)
  const row = await prisma.warmLeadSettings.update({ where: { tenantId }, data: { ...data, updatedBy: by } })
  await audit({ tenantId, actorType: 'user', actorCrmUserId: by, action: `warmleads.${action}`, resourceType: 'WarmLeadSettings', resourceId: tenantId, summary })
  return row
}

/** Start (paused = false) or pause. Pausing is always allowed; starting needs a pilot to run or an approved pilot. */
export async function setPaused(tenantId: string, paused: boolean, by: string): Promise<WarmLeadSettings> {
  const s = await ensureSettings(tenantId)
  if (!paused) {
    if (!env.WARM_LEADS_WORKER_ENABLED) {
      throw new ConflictError('The Warm Leads worker is switched off on this server (WARM_LEADS_WORKER_ENABLED). Nothing would run.')
    }
    const keyProblem = warmLeadsKeyProblem()
    if (keyProblem) throw new ConflictError(`Warm Leads cannot start: ${keyProblem}`)
    if (!s.pilotApprovedAt) {
      const pilot = await prisma.warmLeadRun.findFirst({ where: { tenantId, kind: 'pilot', status: { in: ['preparing', 'queued', 'running'] } }, select: { id: true } })
      if (!pilot) throw new ConflictError('Prepare the pilot first: nothing else is evaluated before the pilot is approved.')
    } else if ((await prisma.warmLeadCompany.count({ where: { tenantId, inCrm: true } })) === 0) {
      throw new ConflictError('Read the company list from NXT Sales first.')
    }
  }
  return change(tenantId, by, { paused }, paused ? 'paused' : 'started', paused ? 'Warm-lead processing paused.' : 'Warm-lead processing started.')
}

export async function updateLimits(tenantId: string, by: string, u: LimitUpdate): Promise<WarmLeadSettings> {
  const s = await ensureSettings(tenantId)
  const checked = checkLimitUpdate(s, u)
  if (!checked.ok) throw new BadRequestError(checked.error)
  return change(tenantId, by, checked.value, 'limits_changed', `Warm-lead limits changed: ${JSON.stringify(checked.value)}.`)
}

export async function updateWindow(tenantId: string, by: string, w: { start: string; end: string; timezone: string }): Promise<WarmLeadSettings> {
  const checked = checkWindow(w)
  if (!checked.ok) throw new BadRequestError(checked.error)
  return change(tenantId, by, { windowStart: checked.value.start, windowEnd: checked.value.end, timezone: checked.value.timezone }, 'window_changed', `Warm-lead window set to ${checked.value.start}–${checked.value.end} ${checked.value.timezone}.`)
}

/** The admin asks for the company list to be read again; the worker does it (the API never reads 15,000 companies). */
export async function requestListRefresh(tenantId: string, by: string): Promise<WarmLeadSettings> {
  return change(tenantId, by, { listRefreshRequestedAt: new Date(), listRefreshState: 'requested', listRefreshMessage: null }, 'list_refresh_requested', 'Reading the company list from NXT Sales was requested.')
}

export async function approveScale(tenantId: string, by: string, level: number): Promise<WarmLeadSettings> {
  const s = await ensureSettings(tenantId)
  const checked = checkScaleApproval({ approvedMaxCompanies: s.approvedMaxCompanies, approvedMaxCeiling: s.approvedMaxCeiling, pilotApproved: Boolean(s.pilotApprovedAt) }, level)
  if (!checked.ok) throw new ConflictError(checked.error)
  return change(
    tenantId,
    by,
    { approvedMaxCompanies: checked.value.companies, approvedMaxCeiling: checked.value.ceiling, scaleApprovedAt: new Date(), scaleApprovedBy: by },
    'scale_approved',
    `Up to ${checked.value.companies} companies and ${checked.value.ceiling} Gemini calls a day approved. The limits themselves are unchanged until set.`,
  )
}

/** Approves sending Warm / Early Signal results to NXT Sales. Needs the approved pilot; the server switch must also be on. */
export async function approveSync(tenantId: string, by: string): Promise<WarmLeadSettings> {
  const s = await ensureSettings(tenantId)
  if (!s.pilotApprovedAt) throw new ConflictError('The pilot must be approved before anything is sent to NXT Sales.')
  if (!env.WARM_LEADS_SYNC_ENABLED) throw new ConflictError('Sending to NXT Sales is switched off on this server (WARM_LEADS_SYNC_ENABLED). It must be enabled there first.')
  return change(tenantId, by, { syncEnabled: true, syncApprovedAt: new Date(), syncApprovedBy: by }, 'sync_approved', 'Sending Warm and Early Signal results to NXT Sales approved and switched on.')
}

export async function disableSync(tenantId: string, by: string): Promise<WarmLeadSettings> {
  return change(tenantId, by, { syncEnabled: false }, 'sync_disabled', 'Sending results to NXT Sales switched off.')
}

/** Every tenant the worker has to look after: those whose Warm Leads section was opened. */
export async function tenantsWithSettings(): Promise<string[]> {
  return (await prisma.warmLeadSettings.findMany({ select: { tenantId: true } })).map((r) => r.tenantId)
}
