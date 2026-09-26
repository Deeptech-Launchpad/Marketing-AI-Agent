import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { logger } from '../platform/logger.js'
import { assertPublicHost, normalizeUrl } from './ssrfGuard.js'

// PAGE CAPTURE — A PICTURE OF A PAGE, TAKEN BY A REAL BROWSER.
//
// The PDP Enrichment Report shows the customer's product page as it looks
// today, and the enriched page as it would look. Both are photographs taken by
// a headless Chrome on this machine.
//
// A browser fetches far more than the page itself — images, scripts, fonts —
// and it does so with its own network stack, outside the guarded transport the
// crawler uses. So every request it makes is PAUSED and checked here first:
// only http(s) to a host that resolves to public addresses is allowed through,
// the same rule the crawler applies (see ssrfGuard). Everything else is failed
// before it leaves the machine. Pages are captured read-only: nothing is
// clicked, no form is submitted, no cookie jar survives the capture.
//
// Off unless PAGE_CAPTURE_ENABLED is on and a Chrome binary is available. When
// it is off, callers get null and the report states that no capture was taken.

const VIEWPORT_WIDTH = 1280
const MAX_HEIGHT = 2600
const NAV_TIMEOUT_MS = 25_000
/** Bounds on embedding a page's own pictures into a capture. */
const MAX_INLINE_IMAGES = 12
const MAX_INLINE_BYTES = 4_000_000
/** Long edge a re-encoded picture is reduced to before it is stored. */
const INLINE_MAX_EDGE = 900

export interface CaptureResult {
  ok: boolean
  /** JPEG bytes of the full page, clipped to MAX_HEIGHT. */
  image: Buffer | null
  width: number
  height: number
  reason: string | null
  blockedRequests: number
  /** The rendered DOM, when requested. */
  html?: string
  /** Where the browser ended up, when a URL was opened. */
  finalUrl?: string | null
  /** Pictures read out of the page, as data: URIs, keyed by requested URL. */
  images?: Record<string, string>
}

const COMMON_CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

export function chromePath(): string | null {
  if (env.CHROME_PATH && existsSync(env.CHROME_PATH)) return env.CHROME_PATH
  return COMMON_CHROME_PATHS.find((p) => existsSync(p)) ?? null
}

export function captureAvailable(): { ok: boolean; reason: string | null } {
  if (!env.PAGE_CAPTURE_ENABLED) return { ok: false, reason: 'PAGE_CAPTURE_ENABLED is off, so no page capture was taken.' }
  if (!chromePath()) return { ok: false, reason: 'No Chrome binary was found (set CHROME_PATH), so no page capture was taken.' }
  return { ok: true, reason: null }
}

/** Captures a live URL. The URL itself is checked before the browser is started. */
export async function captureUrl(rawUrl: string): Promise<CaptureResult> {
  const url = normalizeUrl(rawUrl)
  if (!url) return fail('A valid http(s) URL is required.')
  try {
    await assertPublicHost(url.hostname)
  } catch (err) {
    return fail((err as Error).message)
  }
  return capture({ url: url.toString() })
}

/**
 * Opens a live URL in the browser and returns the DOM after scripts have run.
 *
 * For product pages whose details are injected by JavaScript: the served HTML
 * names the product only in its title, and the browser is the only reader that
 * sees the rest. Same request checks as a capture; no screenshot is taken.
 */
export async function renderUrlHtml(rawUrl: string): Promise<CaptureResult> {
  const url = normalizeUrl(rawUrl)
  if (!url) return fail('A valid http(s) URL is required.')
  try {
    await assertPublicHost(url.hostname)
  } catch (err) {
    return fail((err as Error).message)
  }
  return capture({ url: url.toString(), htmlOnly: true })
}

/**
 * Captures HTML we rendered ourselves. Any images it references are still checked.
 *
 * `baseUrl` is the page whose images the HTML points at. The browser opens it
 * FIRST and only then takes our document, which matters more than it sounds:
 * a shop's image host commonly resets a connection that arrives cold, with no
 * prior page load, no cookies and no same-site referrer, and the pictures then
 * render as broken boxes. Visiting the page first makes the image requests
 * look like what they are — the same browser, on the same site, a moment later.
 * The page is only opened; nothing is read from it, and every request it makes
 * goes through the same public-address check as any other.
 */
export async function captureHtml(html: string, opts: { baseUrl?: string | null } = {}): Promise<CaptureResult> {
  let baseUrl: string | undefined
  if (opts.baseUrl) {
    const url = normalizeUrl(opts.baseUrl)
    if (url) {
      try {
        await assertPublicHost(url.hostname)
        baseUrl = url.toString()
      } catch {
        // Not reachable for us: the capture still runs, without the warm-up.
      }
    }
  }
  return capture({ html, baseUrl })
}

function fail(reason: string): CaptureResult {
  return { ok: false, image: null, width: 0, height: 0, reason, blockedRequests: 0 }
}

/**
 * The pictures a page shows, as bytes, taken from the page itself.
 *
 * WHY THIS EXISTS. A product page's images frequently cannot be fetched by
 * anyone but that page: the image host resets a request that arrives without
 * the site's own session, and some shop themes never publish a fetchable URL at
 * all — the rendered page carries the picture inline. Either way the enriched
 * page, which points at the URLs the markup declares, renders broken boxes.
 *
 * So the browser opens the page and reads the pictures the way a reader sees
 * them: it tries the URL first, and falls back to re-encoding the rendered
 * image element. Everything returned is a data: URI, so whatever shows it next
 * needs no network and cannot be refused.
 *
 * Bounded: MAX_INLINE_IMAGES urls, each re-encoded to at most INLINE_MAX_EDGE
 * pixels on its long edge. Anything that cannot be read is simply absent from
 * the map, and the caller keeps its original URL.
 */
export async function inlineImagesFromPage(pageUrl: string, urls: string[]): Promise<Record<string, string>> {
  const available = captureAvailable()
  if (!available.ok || urls.length === 0) return {}
  const url = normalizeUrl(pageUrl)
  if (!url) return {}
  try {
    await assertPublicHost(url.hostname)
  } catch {
    return {}
  }
  const result = await capture({ url: url.toString(), collectImages: urls.slice(0, MAX_INLINE_IMAGES) })
  return result.images ?? {}
}

/**
 * Reads the requested pictures inside the page, and returns data: URIs.
 *
 * Two attempts per URL, in order:
 *   1. fetch it from the page's own origin — works wherever the host allows it;
 *   2. otherwise find the rendered <img> that IS that picture (the same file
 *      name, or the page's largest picture when the theme inlined it under a
 *      different address) and re-encode what the browser already decoded.
 *
 * The second attempt is what rescues a shop whose images cannot be fetched at
 * all. A cross-origin image without permission cannot be re-encoded — the
 * canvas refuses — and is left out rather than guessed at.
 */
async function readImages(
  urls: string[],
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>,
  sessionId: string,
): Promise<Record<string, string>> {
  const expression = `(async () => {
    const wanted = ${JSON.stringify(urls)}
    const out = {}
    const stem = (u) => { try { return new URL(u, location.href).pathname.split('/').pop().split('.')[0].toLowerCase() } catch { return '' } }
    const encode = (img) => {
      try {
        const scale = Math.min(1, ${INLINE_MAX_EDGE} / Math.max(img.naturalWidth, img.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        const data = canvas.toDataURL('image/jpeg', 0.82)
        return data.length > 40 ? data : ''
      } catch {
        return ''
      }
    }
    const rendered = [...document.images].filter((i) => i.complete && i.naturalWidth > 80 && i.naturalHeight > 80)
    const byArea = [...rendered].sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)

    for (const u of wanted) {
      try {
        const res = await fetch(u, { credentials: 'include' })
        if (res.ok) {
          const blob = await res.blob()
          if (blob.type.startsWith('image/') && blob.size <= ${MAX_INLINE_BYTES}) {
            out[u] = await new Promise((resolve) => {
              const reader = new FileReader()
              reader.onload = () => resolve(String(reader.result))
              reader.onerror = () => resolve('')
              reader.readAsDataURL(blob)
            })
            if (out[u]) continue
          }
        }
      } catch {
        /* falls through to the rendered image */
      }
      const want = stem(u)
      const match =
        rendered.find((i) => stem(i.currentSrc || i.src) === want && want) ||
        rendered.find((i) => (i.srcset || '').toLowerCase().includes(want) && want)
      const picked = match || byArea[wanted.indexOf(u)] || byArea[0]
      if (picked) {
        const data = encode(picked)
        if (data) out[u] = data
      }
    }
    return JSON.stringify(out)
  })()`

  try {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    const map = JSON.parse(String(result.result?.value ?? '{}')) as Record<string, string>
    return Object.fromEntries(Object.entries(map).filter(([, v]) => v.startsWith('data:image/')))
  } catch {
    return {}
  }
}

/** Every http(s) image the document points at, in order, de-duplicated. */
export function imageUrlsIn(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)) {
    const u = m[1]!
    if (/^https?:\/\//i.test(u) && !out.includes(u)) out.push(u)
  }
  return out
}

/**
 * Replaces image links with the bytes themselves, fetched by the page the
 * browser is currently standing on.
 *
 * Bounded: at most MAX_INLINE_IMAGES, each up to MAX_INLINE_BYTES. An image
 * the page cannot fetch (another host refusing cross-origin reads, say) keeps
 * its original link and is simply requested normally when the document loads.
 */
async function inlineImages(
  html: string,
  send: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>,
  sessionId: string,
): Promise<string> {
  const urls = imageUrlsIn(html).slice(0, MAX_INLINE_IMAGES)
  if (!urls.length) return html

  const expression = `(async () => {
    const out = {}
    for (const u of ${JSON.stringify(urls)}) {
      try {
        const res = await fetch(u, { credentials: 'include' })
        if (!res.ok) continue
        const blob = await res.blob()
        if (!blob.type.startsWith('image/') || blob.size > ${MAX_INLINE_BYTES}) continue
        out[u] = await new Promise((resolve) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => resolve('')
          reader.readAsDataURL(blob)
        })
      } catch {
        /* left as a link */
      }
    }
    return JSON.stringify(out)
  })()`

  try {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
    const map = JSON.parse(String(result.result?.value ?? '{}')) as Record<string, string>
    let out = html
    for (const [url, dataUri] of Object.entries(map)) {
      if (dataUri.startsWith('data:image/')) out = out.split(`"${url}"`).join(`"${dataUri}"`)
    }
    return out
  } catch {
    return html
  }
}

async function capture(target: {
  url?: string
  html?: string
  htmlOnly?: boolean
  baseUrl?: string
  /** Read these pictures out of the opened page instead of photographing it. */
  collectImages?: string[]
}): Promise<CaptureResult> {
  const available = captureAvailable()
  if (!available.ok) return fail(available.reason!)

  const profile = mkdtempSync(join(tmpdir(), 'anxt-capture-'))
  let chrome: ChildProcess | null = null
  let ws: WebSocket | null = null
  try {
    chrome = spawn(
      chromePath()!,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        `--window-size=${VIEWPORT_WIDTH},1000`,
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    )

    const browserWs = await new Promise<string>((resolve, reject) => {
      let buf = ''
      const timer = setTimeout(() => reject(new Error('Chrome did not start in time.')), 15_000)
      chrome!.stderr!.on('data', (d: Buffer) => {
        buf += d.toString()
        const m = buf.match(/DevTools listening on (ws:\/\/\S+)/)
        if (m) {
          clearTimeout(timer)
          resolve(m[1]!)
        }
      })
      chrome!.on('exit', () => {
        clearTimeout(timer)
        reject(new Error('Chrome exited before it was ready.'))
      })
    })

    ws = new WebSocket(browserWs)
    await new Promise((resolve, reject) => {
      ws!.addEventListener('open', resolve, { once: true })
      ws!.addEventListener('error', () => reject(new Error('Could not connect to Chrome.')), { once: true })
    })

    let nextId = 1
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    const listeners: Array<(msg: any) => void> = []
    ws.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data))
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)!
        pending.delete(msg.id)
        if (msg.error) p.reject(new Error(msg.error.message))
        else p.resolve(msg.result)
      } else {
        listeners.forEach((l) => l(msg))
      }
    })
    const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        ws!.send(JSON.stringify({ id, method, params, sessionId }))
      })

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })

    // Every request the page makes is checked before it is allowed out.
    let blockedRequests = 0
    const hostVerdicts = new Map<string, Promise<boolean>>()
    const hostAllowed = (hostname: string) => {
      if (!hostVerdicts.has(hostname)) {
        hostVerdicts.set(
          hostname,
          assertPublicHost(hostname).then(
            () => true,
            () => false,
          ),
        )
      }
      return hostVerdicts.get(hostname)!
    }
    listeners.push((msg) => {
      if (msg.method !== 'Fetch.requestPaused' || msg.sessionId !== sessionId) return
      const { requestId, request } = msg.params
      void (async () => {
        let allowed = false
        try {
          const u = new URL(request.url)
          if (u.protocol === 'data:' || u.protocol === 'blob:') allowed = true
          else if (u.protocol === 'http:' || u.protocol === 'https:') allowed = await hostAllowed(u.hostname)
        } catch {
          allowed = false
        }
        if (allowed && request.method !== 'GET' && request.method !== 'HEAD') allowed = false
        if (allowed) await send('Fetch.continueRequest', { requestId }, sessionId).catch(() => undefined)
        else {
          blockedRequests++
          await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => undefined)
        }
      })()
    })

    await send('Page.enable', {}, sessionId)
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId)
    await send(
      'Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT_WIDTH, height: 1000, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )

    const loaded = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, NAV_TIMEOUT_MS)
      listeners.push((msg) => {
        if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) {
          clearTimeout(timer)
          resolve()
        }
      })
    })

    if (target.url) {
      const nav = await send('Page.navigate', { url: target.url }, sessionId)
      if (nav.errorText) return fail(`The page could not be opened: ${nav.errorText}`)
    } else {
      // PICTURES THAT ONLY LOAD ON THEIR OWN SITE.
      //
      // A shop's image host commonly refuses a request that arrives cold — no
      // prior page load, no cookies, no same-site referrer — and resets the
      // connection, which is why the enriched page rendered with broken image
      // boxes while the customer's own page photographed perfectly.
      //
      // So the browser opens THEIR page first and, standing on that page,
      // fetches each image the enriched page needs. Those requests come from
      // the same origin the images belong to, so the host serves them. The
      // bytes are then embedded in the document that gets photographed, which
      // needs no network at all.
      let html = target.html ?? ''
      if (target.baseUrl) {
        await send('Page.navigate', { url: target.baseUrl }, sessionId).catch(() => undefined)
        await Promise.race([
          new Promise<void>((resolve) => {
            listeners.push((msg) => {
              if (msg.method === 'Page.loadEventFired' && msg.sessionId === sessionId) resolve()
            })
          }),
          new Promise<void>((resolve) => setTimeout(resolve, 12_000)),
        ])
        html = await inlineImages(html, send, sessionId)
      }
      const { frameTree } = await send('Page.getFrameTree', {}, sessionId)
      await send('Page.setDocumentContent', { frameId: frameTree.frame.id, html }, sessionId)
    }
    await loaded

    if (target.collectImages) {
      // Give a script-rendered gallery a moment to put its pictures in place.
      await new Promise((r) => setTimeout(r, 1500))
      const images = await readImages(target.collectImages, send, sessionId)
      return { ok: true, image: null, width: 0, height: 0, reason: null, blockedRequests, images }
    }

    // Walk down the page so lazily loaded images request themselves, then settle.
    await send(
      'Runtime.evaluate',
      {
        expression: `(async () => { for (let y = 0; y < Math.min(document.body.scrollHeight, ${MAX_HEIGHT}); y += 800) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)) } window.scrollTo(0, 0) })()`,
        awaitPromise: true,
      },
      sessionId,
    ).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 1500))

    if (target.htmlOnly) {
      const dom = await send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true }, sessionId)
      const loc = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, sessionId)
      return {
        ok: true,
        image: null,
        width: 0,
        height: 0,
        reason: null,
        blockedRequests,
        html: String(dom.result?.value ?? ''),
        finalUrl: String(loc.result?.value ?? target.url ?? ''),
      }
    }

    const metrics = await send('Page.getLayoutMetrics', {}, sessionId)
    const size = metrics.cssContentSize ?? metrics.contentSize
    const height = Math.max(600, Math.min(Math.ceil(size.height), MAX_HEIGHT))
    await send(
      'Emulation.setDeviceMetricsOverride',
      { width: VIEWPORT_WIDTH, height, deviceScaleFactor: 1, mobile: false },
      sessionId,
    )
    const shot = await send(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width: VIEWPORT_WIDTH, height, scale: 1 } },
      sessionId,
    )
    return {
      ok: true,
      image: Buffer.from(shot.data, 'base64'),
      width: VIEWPORT_WIDTH,
      height,
      reason: null,
      blockedRequests,
    }
  } catch (err) {
    logger.info({ err: (err as Error).message }, 'page capture failed')
    return fail(`The page could not be captured: ${(err as Error).message}`)
  } finally {
    try {
      ws?.close()
    } catch {
      /* already closed */
    }
    chrome?.kill()
    // Chrome releases its profile lock a moment after exit.
    setTimeout(() => rmSync(profile, { recursive: true, force: true }), 2000).unref()
  }
}
