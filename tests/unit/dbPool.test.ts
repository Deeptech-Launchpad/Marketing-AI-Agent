import { describe, expect, it, vi } from 'vitest'

// DATABASE CONNECTIONS (2026-10-09): the PostgreSQL server is shared with NXT
// Sales and other apps (100 connections in all), so each process caps its own
// Prisma pool, and a limit already in the address wins.

vi.mock('../../src/config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    MARKETING_DATABASE_URL: 'postgresql://u:p@db.example:5433/nxt_marketing?schema=marketing',
    MARKETING_DB_CONNECTION_LIMIT_API: 3,
    MARKETING_DB_CONNECTION_LIMIT_WORKER: 2,
    MARKETING_DB_POOL_TIMEOUT_SECONDS: 20,
    PGBOSS_MAX_CONNECTIONS: 1,
  },
}))

const { pooledDatabaseUrl } = await import('../../src/platform/db.js')

describe('the database connection pool', () => {
  it('the API process uses at most 3 connections, the worker at most 2, waiting up to 20 s', () => {
    const api = new URL(pooledDatabaseUrl(undefined, false))
    expect(api.searchParams.get('connection_limit')).toBe('3')
    expect(api.searchParams.get('pool_timeout')).toBe('20')
    expect(api.searchParams.get('schema')).toBe('marketing')
    expect(new URL(pooledDatabaseUrl(undefined, true)).searchParams.get('connection_limit')).toBe('2')
  })

  it('keeps a limit written into the address itself', () => {
    const u = new URL(pooledDatabaseUrl('postgresql://u:p@h:5433/db?schema=marketing&connection_limit=9&pool_timeout=5', true))
    expect(u.searchParams.get('connection_limit')).toBe('9')
    expect(u.searchParams.get('pool_timeout')).toBe('5')
  })
})
