import { PrismaClient } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'
import { env } from '../config/env.js'

// Single Prisma client for the process. Note this points at the `marketing`
// schema only (see MARKETING_DATABASE_URL) — this service never reads or writes
// NXT Sales tables directly, even though they live in the same database. All
// CRM access goes through the CRM port over HTTP.
export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

/** Ids are cuid, matching NXT Sales' own convention. */
export const newId = createId

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}
