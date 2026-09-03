import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'

// Thin Apify REST client. Deliberately not the Apify SDK: one POST, one poll,
// one dataset GET is the whole surface, and a dependency would mostly add
// abstraction over three URLs.
//
// Everything Apify returns is UNTRUSTED THIRD-PARTY DATA. It is stored as
// evidence and never interpreted as instruction — no external content can
// select a tool, change a permission or trigger any action in this codebase.

const APIFY_BASE = 'https://api.apify.com/v2'

export interface ApifyRunResult<T> {
  ok: boolean
  items: T[]
  runId?: string
  status?: string
  reason?: string
  /** Apify's own reported spend for this run, for cost audit. */
  costUsd?: number
  datasetId?: string
}

export function apifyAvailable(): { ok: boolean; reason?: string } {
  if (!env.APIFY_TOKEN) {
    return { ok: false, reason: 'APIFY_TOKEN is not set; Apify-backed collection is disabled.' }
  }
  return { ok: true }
}

/**
 * Starts an Actor and waits for it, bounded by APIFY_TIMEOUT_MS.
 *
 * Uses run-sync-get-dataset-items, which blocks server-side and returns the
 * dataset in one call — it avoids a poll loop, and Apify enforces its own
 * ceiling so a hung Actor cannot hold this worker indefinitely.
 */
export async function runActor<T>(
  actorId: string,
  input: Record<string, unknown>,
  opts: { maxItems?: number } = {},
): Promise<ApifyRunResult<T>> {
  const availability = apifyAvailable()
  if (!availability.ok) return { ok: false, items: [], reason: availability.reason }

  const url = new URL(`${APIFY_BASE}/acts/${actorId}/run-sync-get-dataset-items`)
  url.searchParams.set('token', env.APIFY_TOKEN)
  if (opts.maxItems) url.searchParams.set('maxItems', String(opts.maxItems))
  // Apify's own timeout, so the Actor is killed rather than merely abandoned.
  url.searchParams.set('timeout', String(Math.floor(env.APIFY_TIMEOUT_MS / 1000)))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), env.APIFY_TIMEOUT_MS)

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: controller.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      // Never echo the URL back: it carries the token.
      return {
        ok: false,
        items: [],
        reason: `Apify actor ${actorId} returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      }
    }

    const items = (await res.json()) as T[]
    const runId = res.headers.get('x-apify-actor-run-id') ?? undefined

    return { ok: true, items: Array.isArray(items) ? items : [], runId }
  } catch (err) {
    const aborted = (err as Error).name === 'AbortError'
    return {
      ok: false,
      items: [],
      reason: aborted
        ? `Apify actor ${actorId} exceeded ${env.APIFY_TIMEOUT_MS}ms and was abandoned.`
        : `Apify actor ${actorId} failed: ${(err as Error).message}`,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Actual spend for a finished run, read back for the cost audit. */
export async function runCost(runId: string): Promise<number | null> {
  if (!env.APIFY_TOKEN || !runId) return null
  try {
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${env.APIFY_TOKEN}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { usageTotalUsd?: number } }
    return body.data?.usageTotalUsd ?? null
  } catch (err) {
    logger.debug({ err }, 'could not read Apify run cost')
    return null
  }
}

/** Remaining monthly credit, so a batch can be refused before it overspends. */
export async function accountUsage(): Promise<{ usedUsd: number; limitUsd: number } | null> {
  if (!env.APIFY_TOKEN) return null
  try {
    const res = await fetch(`${APIFY_BASE}/users/me/limits?token=${env.APIFY_TOKEN}`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as {
      data?: { current?: { monthlyUsageUsd?: number }; limits?: { maxMonthlyUsageUsd?: number } }
    }
    return {
      usedUsd: body.data?.current?.monthlyUsageUsd ?? 0,
      limitUsd: body.data?.limits?.maxMonthlyUsageUsd ?? 0,
    }
  } catch {
    return null
  }
}
