import { env } from '../config/env.js'

// A REDDIT THREAD, READ THROUGH REDDIT'S OFFICIAL API.
//
// Reddit serves a plain page fetch a script shell with almost no text, and it
// refuses anonymous reads of its thread data (HTTP 403). The Community
// Engagement method names the way in (section 4.1: "Reddit has an official,
// free API … we're only reading public posts"): an application-only token
// from a registered app, then the thread from oauth.reddit.com. Read-only,
// public posts only, one request per thread.
//
// Without REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET nothing is requested from
// Reddit at all, and the caller reports why. Nothing is ever worked around.
//
// The two hosts are fixed and the thread id is validated, so no address from
// a search result is ever fetched with the token attached.

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token'
const API = 'https://oauth.reddit.com'
const TIMEOUT_MS = 12_000

export function redditConfigured(): boolean {
  return Boolean(env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET)
}

/** "/r/<sub>/comments/<id>" of a Reddit thread address, or null. */
export function redditThreadPath(url: string): string | null {
  try {
    const u = new URL(url)
    if (!/(^|\.)reddit\.com$/i.test(u.hostname)) return null
    const m = u.pathname.match(/^\/r\/([A-Za-z0-9_]{2,21})\/comments\/([a-z0-9]{3,12})(\/|$)/i)
    return m ? `/r/${m[1]}/comments/${m[2]!.toLowerCase()}` : null
  } catch {
    return null
  }
}

interface Thing {
  kind?: string
  data?: {
    title?: string
    selftext?: string
    body?: string
    author?: string
    author_flair_text?: string | null
    subreddit?: string
    created_utc?: number
    replies?: { data?: { children?: Thing[] } } | ''
  }
}

function day(utc: number | undefined): string | null {
  return typeof utc === 'number' && utc > 0 ? new Date(utc * 1000).toISOString().slice(0, 10) : null
}

function line(kind: 'Post' | 'Comment', d: NonNullable<Thing['data']>): string {
  const who = d.author ? `u/${d.author}` : 'someone'
  const flair = d.author_flair_text ? `, flair: ${d.author_flair_text}` : ''
  const when = day(d.created_utc)
  const text = [d.title, d.selftext ?? d.body].filter(Boolean).join('\n')
  return `${kind} by ${who}${flair}${when ? ` on ${when}` : ''}:\n${text}`
}

/** Plain text of a thread's JSON: the post, then its comments in order. Pure. */
export function redditThreadText(json: unknown): string {
  const listings = Array.isArray(json) ? (json as Array<{ data?: { children?: Thing[] } }>) : []
  const out: string[] = []
  const post = listings[0]?.data?.children?.[0]?.data
  if (post) out.push(`r/${post.subreddit ?? ''}\n${line('Post', post)}`)
  const walk = (children: Thing[] | undefined) => {
    for (const c of children ?? []) {
      if (out.length > 80) return
      if (c.kind !== 't1' || !c.data?.body) continue
      out.push(line('Comment', c.data))
      if (c.data.replies && typeof c.data.replies === 'object') walk(c.data.replies.data?.children)
    }
  }
  walk(listings[1]?.data?.children)
  return out.join('\n\n')
}

let token: { value: string; expiresAt: number } | null = null

async function accessToken(): Promise<string> {
  if (token && token.expiresAt > Date.now() + 60_000) return token.value
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': env.RESEARCH_USER_AGENT,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`Reddit declined the API credentials (HTTP ${res.status}).`)
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) throw new Error('Reddit returned no access token.')
  token = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
  return token.value
}

/**
 * Reads one thread through the official API. Never throws. `refused` means
 * Reddit said no (credentials, 403, 429); the caller stops asking this run.
 */
export async function readRedditThread(url: string): Promise<{ text: string; refused: boolean; reason: string | null }> {
  if (!redditConfigured()) {
    return { text: '', refused: true, reason: 'Reddit threads are read through Reddit’s official API, and REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set.' }
  }
  const path = redditThreadPath(url)
  if (!path) return { text: '', refused: false, reason: 'Not a Reddit thread address.' }
  try {
    const res = await fetch(`${API}${path}?raw_json=1&limit=60&depth=3`, {
      headers: { Authorization: `Bearer ${await accessToken()}`, 'User-Agent': env.RESEARCH_USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: 'error',
    })
    if (!res.ok) return { text: '', refused: res.status === 403 || res.status === 429 || res.status === 401, reason: `Reddit returned HTTP ${res.status}.` }
    const text = redditThreadText(await res.json())
    return { text, refused: false, reason: text ? null : 'The thread held no readable post.' }
  } catch (err) {
    return { text: '', refused: /declined|access token/.test((err as Error).message), reason: (err as Error).message }
  }
}
