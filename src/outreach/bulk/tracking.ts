import { createHash, randomBytes } from 'node:crypto'
import { env } from '../../config/env.js'
import { prisma } from '../../platform/db.js'
import { logger } from '../../platform/logger.js'

// EMAIL OPEN TRACKING FOR BULK EMAIL (2026-10-09).
//
// How it works: when an email is sent, it gets its own random token, and an
// invisible 1×1 image whose address carries that token is added at the very
// end of the HTML part. When the recipient's mail program loads the image,
// the public endpoint (/api/v1/bulk-open/<token>.gif) counts it for that one
// email: first time, last time, how many times.
//
// What it is NOT: proof of reading. Many mail programs block images (no
// event), and privacy proxies and security scanners can load them without a
// person reading (an event). The screens therefore say "Open detected" and
// "No open detected", never "read" or "not read".
//
// Safety:
//   - The token is 32 random bytes; only its SHA-256 is stored, so the
//     database cannot be used to forge or look up a pixel address, and the
//     address says nothing about who it was sent to.
//   - The endpoint answers every request with the same image, valid or not,
//     so it discloses nothing; no cookie, no login, no IP address or user
//     agent is stored; the token is never logged.
//   - Tracking is only switched on with a verified, publicly reachable HTTPS
//     address (BULK_OPEN_TRACKING_BASE_URL). Without it, emails go exactly
//     as before, with no pixel, and are shown as "Tracking unavailable".
//   - Preparing tracking can never stop an email from being sent.

export const OPEN_PATH = '/api/v1/bulk-open'
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/
/** A runaway (a scanner looping) cannot grow the count without end. */
export const MAX_OPEN_COUNT = 10_000

/** A transparent 1×1 GIF. */
export const PIXEL_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

export function newTrackingToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function isTrackingToken(s: string): boolean {
  return TOKEN_RE.test(s)
}

export interface TrackingConfig {
  ok: boolean
  base: string | null
  /** Why tracking is off, in words; null when the configuration is valid. */
  reason: string | null
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/** The configured base address — HTTPS only in production; plain HTTP only to this machine in development. */
export function trackingConfig(): TrackingConfig {
  if (!env.BULK_OPEN_TRACKING_ENABLED) return { ok: false, base: null, reason: 'Open tracking is switched off on the server (BULK_OPEN_TRACKING_ENABLED).' }
  const raw = env.BULK_OPEN_TRACKING_BASE_URL.trim().replace(/\/+$/, '')
  if (!raw) return { ok: false, base: null, reason: 'No public HTTPS address is configured for open tracking (BULK_OPEN_TRACKING_BASE_URL).' }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, base: null, reason: 'BULK_OPEN_TRACKING_BASE_URL is not a valid address.' }
  }
  const devLocal = env.NODE_ENV !== 'production' && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !devLocal) return { ok: false, base: null, reason: 'BULK_OPEN_TRACKING_BASE_URL must be an https:// address.' }
  if (url.username || url.password || url.search || url.hash) return { ok: false, base: null, reason: 'BULK_OPEN_TRACKING_BASE_URL must be a plain address (no login, query or fragment).' }
  return { ok: true, base: `${url.origin}${url.pathname === '/' ? '' : url.pathname}`, reason: null }
}

export function pixelUrl(base: string, token: string): string {
  return `${base}${OPEN_PATH}/${token}.gif`
}

/** The invisible image, appended at the end of the HTML part. The text part is untouched. */
export function addPixel(html: string, url: string): string {
  const img = `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;margin:0;padding:0;opacity:0" />`
  const end = html.lastIndexOf('</div>')
  return end >= 0 && end === html.length - '</div>'.length ? `${html.slice(0, end)}${img}</div>` : `${html}${img}`
}

// ── Is the public address really reachable? ────────────────────────────────

type Probe = (url: string) => Promise<boolean>

const realProbe: Probe = async (url) => {
  const res = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000) })
  return res.status === 200 && res.headers.get('x-open-tracking') === 'ok' && (res.headers.get('content-type') ?? '').startsWith('image/gif')
}

let probe: Probe = realProbe
let cache: { base: string; ok: boolean; at: number; reason: string | null } | null = null
const OK_FOR_MS = 10 * 60_000
const FAILED_FOR_MS = 2 * 60_000

export function setTrackingProbeForTests(p: Probe | null): void {
  probe = p ?? realProbe
  cache = null
}

/**
 * Whether new emails can carry a pixel right now: a valid configuration AND
 * the endpoint answered through the public address recently.
 */
export async function trackingReady(now = new Date()): Promise<TrackingConfig> {
  const cfg = trackingConfig()
  if (!cfg.ok || !cfg.base) return cfg
  const fresh = cache && cache.base === cfg.base && now.getTime() - cache.at < (cache.ok ? OK_FOR_MS : FAILED_FOR_MS)
  if (!fresh) {
    let ok = false
    let reason: string | null = null
    try {
      ok = await probe(`${cfg.base}${OPEN_PATH}/ping.gif`)
      if (!ok) reason = `The open-tracking address ${cfg.base} did not answer as expected, so tracking is off until it does.`
    } catch (err) {
      reason = `The open-tracking address ${cfg.base} could not be reached (${String((err as Error).message ?? err).split('\n')[0]}), so tracking is off until it can.`
    }
    cache = { base: cfg.base, ok, at: now.getTime(), reason }
    if (!ok) logger.warn({ base: cfg.base }, 'bulk email open tracking: the public address did not answer; tracking is off')
  }
  return cache!.ok ? cfg : { ok: false, base: null, reason: cache!.reason }
}

/** What the screens show about tracking, without making a request. */
export function trackingStatusForScreen(): { enabled: boolean; reason: string | null } {
  const cfg = trackingConfig()
  if (!cfg.ok) return { enabled: false, reason: cfg.reason }
  if (cache && cache.base === cfg.base && !cache.ok) return { enabled: false, reason: cache.reason }
  return { enabled: true, reason: null }
}

// ── Recording an open ──────────────────────────────────────────────────────

/**
 * Counts one image request for the email this token belongs to. Atomic: two
 * requests at once both count, and only the first sets "first open". An
 * unknown or malformed token changes nothing. Never throws.
 */
export async function recordOpen(token: string, now = new Date()): Promise<boolean> {
  if (!isTrackingToken(token)) return false
  const trackingTokenHash = hashToken(token)
  try {
    const hit = await prisma.bulkEmailRecipient.updateMany({
      where: { trackingTokenHash, trackingEnabled: true, status: { in: ['sending', 'sent'] }, openCount: { lt: MAX_OPEN_COUNT } },
      data: { openCount: { increment: 1 }, lastOpenedAt: now },
    })
    if (hit.count !== 1) return false
    await prisma.bulkEmailRecipient.updateMany({ where: { trackingTokenHash, firstOpenedAt: null }, data: { firstOpenedAt: now } })
    return true
  } catch (err) {
    // The token is not logged.
    logger.error({ err: String((err as Error).message ?? err).slice(0, 200) }, 'bulk email open tracking: an open could not be recorded')
    return false
  }
}
