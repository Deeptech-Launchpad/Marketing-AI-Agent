import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import { authCapabilities, signInWithGoogle } from '../../auth/service.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'

// SIGNING IN — THE ONLY UNAUTHENTICATED ROUTES UNDER /api/v1.
//
// Two of them, because there is only one way in: read what the sign-in screen
// may draw, and hand over a Google token. Everything else stays behind the
// authenticate middleware.
//
// There is no register, no password and no reset endpoint, because there are
// no passwords. Google decides who somebody is; configuration decides whether
// they may sign in and whether they are an admin.

export const authRoutes = Router()

/** The front door of a platform that can read the whole CRM. */
const signInLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a few minutes and try again.' } },
})

/** What the sign-in screen may draw. Public by necessity: read before sign-in. */
authRoutes.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    res.json(authCapabilities())
  }),
)

authRoutes.post(
  '/google',
  signInLimit,
  validateBody(z.object({ credential: z.string().min(10).max(8000) }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { credential: string }
    res.json(await signInWithGoogle({ credential: body.credential, requestId: req.requestId ?? null }))
  }),
)
