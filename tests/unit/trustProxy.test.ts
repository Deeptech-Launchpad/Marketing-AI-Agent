import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Server } from 'node:http'

// ONE RATE-LIMIT BUCKET PER PERSON, NOT ONE FOR THE WHOLE COMPANY (2026-10-06).
//
// In production every request arrives through nginx on the same machine, so
// the connection always comes from 127.0.0.1. Express ignored the caller's
// real address in X-Forwarded-For, every user counted as the same caller, and
// the sign-in limits applied to the company as a whole. The live error log
// showed it: ERR_ERL_UNEXPECTED_X_FORWARDED_FOR at every start.
//
// These requests come from 127.0.0.1 — exactly as nginx's do — carrying
// different forwarded addresses, and each must get its own allowance.

let server: Server
let base = ''

beforeAll(async () => {
  const { createServer } = await import('../../src/server.js')
  const app = createServer()
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

/** What the general limiter says is left for this caller. */
const remaining = async (forwardedFor?: string) => {
  const res = await fetch(`${base}/api/v1/auth/capabilities`, {
    headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {},
  })
  const header = res.headers.get('ratelimit') ?? ''
  return Number(/remaining=(\d+)/.exec(header)?.[1])
}

describe('behind nginx', () => {
  it('counts two people behind the proxy separately', async () => {
    const a = await remaining('203.0.113.10')
    const b = await remaining('203.0.113.20')
    // Before the fix the second caller saw one fewer — they shared a bucket.
    expect(b).toBe(a)
  })

  it('still counts the same person’s requests together', async () => {
    const first = await remaining('203.0.113.30')
    const second = await remaining('203.0.113.30')
    expect(second).toBe(first - 1)
  })
})

describe('called directly, not through nginx', () => {
  it('trusts the forwarded address only from this machine', async () => {
    const { createServer } = await import('../../src/server.js')
    const trust = createServer().get('trust proxy fn') as (addr: string, hop: number) => boolean
    expect(trust('127.0.0.1', 0)).toBe(true)
    expect(trust('::1', 0)).toBe(true)
    // A caller on the internet reaching the API port directly cannot choose
    // its own address by sending the header.
    expect(trust('203.0.113.99', 0)).toBe(false)
    expect(trust('10.0.0.5', 0)).toBe(false)
  })
})
