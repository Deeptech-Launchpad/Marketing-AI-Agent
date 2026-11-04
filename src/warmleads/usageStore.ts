import { Prisma } from '@prisma/client'
import { newId, prisma } from '../platform/db.js'

// ATOMIC DAILY LIMITS.
//
// Every limit is one conditional UPDATE on the bucket's row:
//
//   UPDATE ... SET geminiCalls = geminiCalls + 1 WHERE geminiCalls < geminiCeiling
//
// PostgreSQL takes the row lock, re-checks the condition against the latest committed
// value, and reports how many rows changed. 1 = this caller got the unit, 0 = the limit
// was already reached. There is no read-then-write gap, so two workers (or a worker that
// restarts mid-night) can never spend the same unit twice or go past the limit.
//
// A bucket is the pilot ("pilot") or one night ("day:YYYY-MM-DD", see window.ts).

export interface BucketLimits {
  geminiCeiling: number
  companyLimit: number
  retryLimit: number
}

export interface BucketUsage extends BucketLimits {
  bucket: string
  geminiCalls: number
  companiesStarted: number
  retriesStarted: number
  screened: number
  deepResearched: number
  completed: number
  failed: number
  incomplete: number
  pricedCostUsd: number
  unpricedCalls: number
  stoppedReason: string | null
}

/** The operations the scheduler needs. The real implementation is below; tests use an in-memory one. */
export interface UsageStore {
  ensureBucket(tenantId: string, bucket: string, limits: BucketLimits): Promise<void>
  reserveGeminiCall(tenantId: string, bucket: string): Promise<boolean>
  reserveCompanySlot(tenantId: string, bucket: string, retry: boolean): Promise<boolean>
  releaseCompanySlot(tenantId: string, bucket: string, retry: boolean): Promise<void>
  getBucket(tenantId: string, bucket: string): Promise<BucketUsage | null>
  addProgress(tenantId: string, bucket: string, delta: ProgressDelta): Promise<void>
  setStopped(tenantId: string, bucket: string, reason: string | null): Promise<void>
}

export interface ProgressDelta {
  screened?: number
  deepResearched?: number
  completed?: number
  failed?: number
  incomplete?: number
  pricedCostUsd?: number
  unpricedCalls?: number
}

const n = (v: number | undefined) => Math.max(0, Math.floor(v ?? 0))

export const dbUsageStore: UsageStore = {
  /** Creates the bucket, or brings its limits in line with the current settings (an admin may change them during the night). */
  async ensureBucket(tenantId, bucket, l) {
    await prisma.$executeRaw`
      INSERT INTO "WarmLeadUsage" ("id", "tenantId", "bucket", "geminiCeiling", "companyLimit", "retryLimit", "createdAt", "updatedAt")
      VALUES (${newId()}, ${tenantId}, ${bucket}, ${l.geminiCeiling}, ${l.companyLimit}, ${l.retryLimit}, NOW(), NOW())
      ON CONFLICT ("tenantId", "bucket") DO UPDATE
      SET "geminiCeiling" = EXCLUDED."geminiCeiling", "companyLimit" = EXCLUDED."companyLimit", "retryLimit" = EXCLUDED."retryLimit", "updatedAt" = NOW()`
  },

  async reserveGeminiCall(tenantId, bucket) {
    const rows = await prisma.$executeRaw`
      UPDATE "WarmLeadUsage" SET "geminiCalls" = "geminiCalls" + 1, "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId} AND "bucket" = ${bucket} AND "geminiCalls" < "geminiCeiling"`
    return rows === 1
  },

  async reserveCompanySlot(tenantId, bucket, retry) {
    const rows = await prisma.$executeRaw`
      UPDATE "WarmLeadUsage"
      SET "companiesStarted" = "companiesStarted" + 1,
          "retriesStarted" = "retriesStarted" + ${retry ? 1 : 0},
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId} AND "bucket" = ${bucket}
        AND "companiesStarted" < "companyLimit"
        AND (${retry} = false OR "retriesStarted" < "retryLimit")`
    return rows === 1
  },

  /** Gives a slot back when no company could be claimed for it. */
  async releaseCompanySlot(tenantId, bucket, retry) {
    await prisma.$executeRaw`
      UPDATE "WarmLeadUsage"
      SET "companiesStarted" = GREATEST(0, "companiesStarted" - 1),
          "retriesStarted" = GREATEST(0, "retriesStarted" - ${retry ? 1 : 0}),
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId} AND "bucket" = ${bucket}`
  },

  async getBucket(tenantId, bucket) {
    const r = await prisma.warmLeadUsage.findUnique({ where: { tenantId_bucket: { tenantId, bucket } } })
    return r ? { ...r, pricedCostUsd: Number(r.pricedCostUsd) } : null
  },

  async addProgress(tenantId, bucket, d) {
    await prisma.$executeRaw`
      UPDATE "WarmLeadUsage"
      SET "screened" = "screened" + ${n(d.screened)},
          "deepResearched" = "deepResearched" + ${n(d.deepResearched)},
          "completed" = "completed" + ${n(d.completed)},
          "failed" = "failed" + ${n(d.failed)},
          "incomplete" = "incomplete" + ${n(d.incomplete)},
          "pricedCostUsd" = "pricedCostUsd" + ${new Prisma.Decimal(Math.max(0, d.pricedCostUsd ?? 0))},
          "unpricedCalls" = "unpricedCalls" + ${n(d.unpricedCalls)},
          "updatedAt" = NOW()
      WHERE "tenantId" = ${tenantId} AND "bucket" = ${bucket}`
  },

  async setStopped(tenantId, bucket, reason) {
    await prisma.warmLeadUsage.updateMany({ where: { tenantId, bucket }, data: { stoppedReason: reason } })
  },
}

/** Recent buckets for the usage screen, newest first. */
export async function recentUsage(tenantId: string, limit = 30): Promise<BucketUsage[]> {
  const rows = await prisma.warmLeadUsage.findMany({ where: { tenantId }, orderBy: { bucket: 'desc' }, take: limit })
  return rows.map((r) => ({ ...r, pricedCostUsd: Number(r.pricedCostUsd) }))
}
