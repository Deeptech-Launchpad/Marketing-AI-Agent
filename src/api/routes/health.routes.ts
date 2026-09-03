import { Router } from 'express'
import { getCrm } from '../../crm/index.js'
import { getLlm } from '../../llm/index.js'
import { prisma } from '../../platform/db.js'
import { asyncHandler } from '../middleware/errorHandler.js'

// Liveness and readiness. Public — no token required, and nothing sensitive is
// returned: dependency names and up/down only, never URLs or credentials.

export const healthRoutes = Router()

healthRoutes.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'marketing-agent' })
})

healthRoutes.get(
  '/health/ready',
  asyncHandler(async (_req, res) => {
    const [db, crm, llm] = await Promise.all([
      prisma
        .$queryRaw`SELECT 1`
        .then(() => ({ ok: true }))
        .catch((err: Error) => ({ ok: false, detail: err.message })),
      getCrm()
        .health()
        .catch((err: Error) => ({ ok: false, detail: err.message })),
      getLlm()
        .health()
        .catch((err: Error) => ({ ok: false, detail: err.message })),
    ])

    const ready = db.ok && crm.ok && llm.ok
    res.status(ready ? 200 : 503).json({
      ready,
      checks: { database: db, crm: { ...crm, driver: getCrm().name }, llm: { ...llm, driver: getLlm().name } },
    })
  }),
)
