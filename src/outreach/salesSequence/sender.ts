import { z } from 'zod'
import { prisma } from '../../platform/db.js'

// WHO THE SEQUENCE IS SENT AS — configuration, never copy.
//
// The approved templates were written in one salesperson's voice ("Manoj here,
// from AltiusNxt"). That name is not hard-coded anywhere: templates.ts carries
// [Sender first name] and [Sender company].
//
// 2026-09-29: the PERSON is whoever started the outreach — the logged-in user,
// by their NXT Sales login (TenantMember name and email). They send it from
// their own mail program, so the email is signed as them. Only the company
// name (and an optional signature) is shared, set once by an admin in
// Settings, stored under Tenant.settings.outreachSender. One user's name is
// never used on another user's outreach.

export const SenderSchema = z.object({
  firstName: z.string().trim().max(60).default(''),
  fullName: z.string().trim().max(120).default(''),
  email: z.string().trim().max(200).default(''),
  companyName: z.string().trim().max(120).default(''),
  /** Added under the sign-off name, as written. Optional. */
  signature: z.string().max(1000).default(''),
})
export type SenderConfig = z.infer<typeof SenderSchema>

export const EMPTY_SENDER: SenderConfig = { firstName: '', fullName: '', email: '', companyName: '', signature: '' }

/** What every draft needs from the sender: the two names the copy uses. */
export function senderReady(s: SenderConfig | null): s is SenderConfig {
  return Boolean(s?.firstName.trim() && s.companyName.trim())
}

export async function readSender(tenantId: string): Promise<SenderConfig> {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  const raw = (tenant?.settings as Record<string, unknown> | null)?.outreachSender
  const parsed = SenderSchema.safeParse(raw ?? {})
  return parsed.success ? parsed.data : EMPTY_SENDER
}

/**
 * The sender of one person's outreach: their own name and login email, with
 * the company name and signature from Settings. No person's details are taken
 * from Settings, so no user's name is ever used on someone else's outreach.
 * With no name on record, [Sender first name] stays unfilled and the email
 * cannot be approved until it is.
 */
export async function readSenderFor(tenantId: string, crmUserId: string | null | undefined): Promise<SenderConfig> {
  const shared = await readSender(tenantId)
  const member = crmUserId
    ? await prisma.tenantMember.findFirst({ where: { tenantId, crmUserId }, select: { name: true, email: true } })
    : null
  const fullName = member?.name?.trim() ?? ''
  return {
    firstName: fullName.split(/\s+/)[0] ?? '',
    fullName,
    email: member?.email?.trim() ?? '',
    companyName: shared.companyName,
    signature: shared.signature,
  }
}

export async function writeSender(tenantId: string, value: SenderConfig): Promise<SenderConfig> {
  const clean = SenderSchema.parse(value)
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  const settings = { ...((tenant?.settings as Record<string, unknown> | null) ?? {}), outreachSender: clean }
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: settings as never } })
  return clean
}
