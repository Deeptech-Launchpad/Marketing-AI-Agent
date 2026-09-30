import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import {
  authCapabilities,
  completePasswordReset,
  completeRegistration,
  signInWithPassword,
  startPasswordReset,
  startRegistration,
} from '../../auth/service.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'

// SIGNING IN — THE ONLY UNAUTHENTICATED ROUTES UNDER /api/v1.
//
// Two ways to arrive: an email and password, or a one-time code that proves an
// address before an account exists for it. Everything else stays behind the
// authenticate middleware.
//
// These are the front door of a platform that can read the whole CRM, so they
// are rate-limited harder than the rest of the service — separately for
// guessing (passwords and codes) and for asking (codes to be sent).

export const authRoutes = Router()

/** Guessing: passwords and one-time codes. */
const guessLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a few minutes and try again.' } },
})

/** Asking for a code to be sent, which costs an email each time. */
const sendLimit = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many requests. Wait a while and try again.' } },
})

const Email = z.string().trim().min(3).max(254)
const Password = z.string().min(1).max(200)
const Code = z.string().trim().min(4).max(10)

/** What the sign-in screen may draw. Public by necessity: read before sign-in. */
authRoutes.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    res.json(authCapabilities())
  }),
)

authRoutes.post(
  '/login',
  guessLimit,
  validateBody(z.object({ email: Email, password: Password }).strict()),
  asyncHandler(async (req, res) => {
    res.json(await signInWithPassword(req.body as { email: string; password: string }))
  }),
)

// ── Creating an account: ask for a code, then use it ───────────────────────

authRoutes.post(
  '/register/start',
  sendLimit,
  validateBody(z.object({ email: Email }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string }
    res.json(await startRegistration({ email: body.email, ip: req.ip ?? null, requestId: req.requestId ?? null }))
  }),
)

authRoutes.post(
  '/register/verify',
  guessLimit,
  validateBody(
    z.object({ email: Email, code: Code, password: Password, name: z.string().trim().max(120).optional() }).strict(),
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string; code: string; password: string; name?: string }
    res.status(201).json(await completeRegistration({ ...body, requestId: req.requestId ?? null }))
  }),
)

// ── Recovering an account: the same two steps ──────────────────────────────

authRoutes.post(
  '/forgot/start',
  sendLimit,
  validateBody(z.object({ email: Email }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string }
    res.json(await startPasswordReset({ email: body.email, ip: req.ip ?? null }))
  }),
)

authRoutes.post(
  '/forgot/verify',
  guessLimit,
  validateBody(z.object({ email: Email, code: Code, password: Password }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string; code: string; password: string }
    res.json(await completePasswordReset({ ...body, requestId: req.requestId ?? null }))
  }),
)
