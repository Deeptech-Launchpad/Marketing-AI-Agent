import { PrismaClient } from '@prisma/client'
import { createId } from '@paralleldrive/cuid2'
import { env } from '../config/env.js'

/**
 * Which process this is: the worker (dist/worker.js) or the API and scripts.
 * pm2 starts every app through its own wrapper, so process.argv[1] is the
 * wrapper's path; the script it runs is in pm_exec_path (2026-10-09).
 */
export const isWorkerScript = (script: string | undefined): boolean => /[\\/]worker\.(js|ts)$/.test(script ?? '')
const isWorker = isWorkerScript(process.env.pm_exec_path ?? process.argv[1])

/**
 * The database address with this process's connection limit (2026-10-09).
 * The PostgreSQL server is shared and small (100 connections), so the pool is
 * capped (MARKETING_DB_CONNECTION_LIMIT_API / _WORKER) instead of Prisma's
 * default of 2 × CPUs + 1. A limit already in the address is kept.
 */
export function pooledDatabaseUrl(raw: string = env.MARKETING_DATABASE_URL, worker: boolean = isWorker): string {
  const url = new URL(raw)
  if (!url.searchParams.has('connection_limit')) {
    url.searchParams.set('connection_limit', String(worker ? env.MARKETING_DB_CONNECTION_LIMIT_WORKER : env.MARKETING_DB_CONNECTION_LIMIT_API))
  }
  if (!url.searchParams.has('pool_timeout')) url.searchParams.set('pool_timeout', String(env.MARKETING_DB_POOL_TIMEOUT_SECONDS))
  return url.toString()
}

// Single Prisma client for the process. Note this points at the `marketing`
// schema only (see MARKETING_DATABASE_URL) — this service never reads or writes
// NXT Sales tables directly, even though they live in the same database. All
// CRM access goes through the CRM port over HTTP.
export const prisma = new PrismaClient({
  datasources: { db: { url: pooledDatabaseUrl() } },
  log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
})

/** Ids are cuid, matching NXT Sales' own convention. */
export const newId = createId

export async function disconnect(): Promise<void> {
  await prisma.$disconnect()
}
