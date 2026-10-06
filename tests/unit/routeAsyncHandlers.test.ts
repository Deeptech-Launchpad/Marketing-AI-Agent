import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// NO ROUTE HANDLER CAN TAKE THE WHOLE API DOWN (2026-10-06).
//
// Express 4 does not catch a rejected promise from an async handler, this
// process registers no unhandledRejection handler, and on Node 22 an unhandled
// rejection ends the process. Six public handlers — reachable without signing
// in — were not wrapped, so one database hiccup while an anonymous visitor
// opened a workbench page took the API down for everyone.
//
// asyncHandler passes the error to the error middleware instead. This test
// fails if any route file registers an async handler without it.

const ROUTES = join(process.cwd(), 'src', 'api', 'routes')

describe('route handlers', () => {
  const files = readdirSync(ROUTES).filter((f) => f.endsWith('.ts'))

  it('finds the route files', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(files)('%s wraps every async handler in asyncHandler', (file) => {
    const src = readFileSync(join(ROUTES, file), 'utf8')
    // An async arrow passed straight to a route method, i.e. one that is NOT
    // the argument of asyncHandler( … ).
    const bare = [...src.matchAll(/^(\s*)async \((?:req|_req)\b/gm)].filter((m) => {
      const before = src.slice(Math.max(0, m.index! - 40), m.index!)
      return !/asyncHandler\(\s*$/.test(before)
    })
    expect(bare.map((m) => src.slice(0, m.index!).split('\n').length), `unwrapped async handlers at lines`).toEqual([])
  })
})
