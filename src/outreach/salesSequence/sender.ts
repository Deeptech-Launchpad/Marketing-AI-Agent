import { z } from 'zod'
import { prisma } from '../../platform/db.js'

// WHO THE SEQUENCE IS SENT AS — configuration, never copy.
//
// The approved templates were written in one salesperson's voice ("Manoj here,
// from AltiusNxt"). That name is not hard-coded anywhere: templates.ts carries
// [Sender first name] and [Sender company], filled from here. An admin sets it
// once in Settings; until then those placeholders stay unfilled and no draft
// can be approved.
//
// Stored under Tenant.settings.outreachSender. Other keys in Tenant.settings
// are left exactly as they are.

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

export async function writeSender(tenantId: string, value: SenderConfig): Promise<SenderConfig> {
  const clean = SenderSchema.parse(value)
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { settings: true } })
  const settings = { ...((tenant?.settings as Record<string, unknown> | null) ?? {}), outreachSender: clean }
  await prisma.tenant.update({ where: { id: tenantId }, data: { settings: settings as never } })
  return clean
}
