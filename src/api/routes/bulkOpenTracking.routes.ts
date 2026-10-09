import { Router } from 'express'
import { OPEN_PATH, PIXEL_GIF, recordOpen } from '../../outreach/bulk/tracking.js'

// Bulk Email open tracking — the image a mail program loads (2026-10-09).
//
// Unauthenticated by necessity: a mail program has no login and no cookie.
// It therefore reads nothing but the token in the path and always answers
// with the same 1×1 transparent image — valid, unknown or malformed token
// alike — so it reveals nothing about any recipient. Mounted before /api/v1
// (which requires login); the global rate limit applies; its requests are
// not written to the request log, so tokens never reach the logs.

export const bulkOpenTrackingRoutes = Router()

function sendPixel(res: import('express').Response) {
  res.set({
    'Content-Type': 'image/gif',
    'Content-Length': String(PIXEL_GIF.length),
    // Every load is asked of the server, not a cache.
    'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
    Pragma: 'no-cache',
    Expires: '0',
    // Mail programs load it from other sites.
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  })
  res.status(200).end(PIXEL_GIF)
}

// Used to confirm the public HTTPS address really reaches this endpoint.
bulkOpenTrackingRoutes.get(`${OPEN_PATH}/ping.gif`, (_req, res) => {
  res.set('X-Open-Tracking', 'ok')
  sendPixel(res)
})

bulkOpenTrackingRoutes.get(`${OPEN_PATH}/:file`, async (req, res) => {
  const m = /^([A-Za-z0-9_-]{43})\.gif$/.exec(req.params.file ?? '')
  if (m) await recordOpen(m[1]!)
  sendPixel(res)
})
