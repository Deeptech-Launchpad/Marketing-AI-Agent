import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { z } from 'zod'
import {
  authCapabilities,
  register,
  requestPasswordReset,
  resetPassword,
  signIn,
  signInWithGoogle,
} from '../../auth/service.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { validateBody } from '../middleware/validate.js'

// SIGN-IN ROUTES — THE ONLY UNAUTHENTICATED ROUTES UNDER /api/v1.
//
// Mounted before the authenticate middleware, because somebody signing in does
// not yet have a token. Everything else under /api/v1 stays behind it.
//
// These endpoints are the front door of a platform that can read the whole
// CRM, so they are rate-limited harder than the rest of the service: the
// general limit is 300 requests a minute, which is generous for a person and
// generous for someone guessing passwords.

export const authRoutes = Router()

/** Password and token attempts: slow enough to make guessing pointless. */
const strictLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a few minutes and try again.' } },
})

/** Creating accounts and asking for reset links. */
const createLimit = rateLimit({
  windowMs: 60 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a while and try again.' } },
})

const Email = z.string().trim().min(3).max(254)
const Password = z.string().min(1).max(200)

/** What the sign-in screen may draw. Public by necessity: it is read before sign-in. */
authRoutes.get(
  '/capabilities',
  asyncHandler(async (_req, res) => {
    res.json(authCapabilities())
  }),
)

authRoutes.post(
  '/register',
  createLimit,
  validateBody(z.object({ email: Email, password: Password, name: z.string().trim().max(120).optional() }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string; password: string; name?: string }
    res.status(201).json(await register({ ...body, requestId: req.requestId ?? null }))
  }),
)

authRoutes.post(
  '/login',
  strictLimit,
  validateBody(z.object({ email: Email, password: Password }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string; password: string }
    res.json(await signIn({ ...body, requestId: req.requestId ?? null }))
  }),
)

authRoutes.post(
  '/google',
  strictLimit,
  validateBody(z.object({ credential: z.string().min(10).max(8000) }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { credential: string }
    res.json(await signInWithGoogle({ credential: body.credential, requestId: req.requestId ?? null }))
  }),
)

authRoutes.post(
  '/forgot-password',
  createLimit,
  validateBody(z.object({ email: Email }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { email: string }
    res.json(
      await requestPasswordReset({
        email: body.email,
        ip: req.ip ?? null,
        requestId: req.requestId ?? null,
      }),
    )
  }),
)

authRoutes.post(
  '/reset-password',
  strictLimit,
  validateBody(z.object({ token: z.string().min(10).max(500), password: Password }).strict()),
  asyncHandler(async (req, res) => {
    const body = req.body as { token: string; password: string }
    res.json(await resetPassword({ ...body, requestId: req.requestId ?? null }))
  }),
)
