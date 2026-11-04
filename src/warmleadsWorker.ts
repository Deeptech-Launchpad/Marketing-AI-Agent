import { setCrmProcessReadOnly } from './crm/nxtSales/httpClient.js'
import { requireGeminiBudget } from './llm/gemini/budgetContext.js'
import { disconnect } from './platform/db.js'
import { logger } from './platform/logger.js'
import { env } from './config/env.js'
import { startWorkerLoop } from './warmleads/workerLoop.js'

// THE WARM LEADS WORKER - its own process (PM2 app "nxt-marketing-warmleads").
//
// It shares NOTHING with the API or the main worker at run time: no job queue (it reads its own
// table), no email or campaign code (a test proves its imports cannot reach any), and its own
// database pool. Two guards are set before anything else runs:
//
//   · every NXT Sales request it makes is a permitted GET (the Warm Leads sync, opened by its own
//     scope, is the one exception and is off until approved);
//   · every Gemini call must be reserved against a database budget, or it is refused.
//
// With WARM_LEADS_WORKER_ENABLED off (the default) it starts, says so, and does nothing.

setCrmProcessReadOnly(true)
requireGeminiBudget(true)

async function main() {
  if (!env.WARM_LEADS_WORKER_ENABLED) {
    logger.warn('Warm Leads worker started but WARM_LEADS_WORKER_ENABLED is off: it will do nothing.')
  }
  const loop = startWorkerLoop()
  logger.info({ enabled: env.WARM_LEADS_WORKER_ENABLED, minAvailableMb: env.WARM_LEADS_MIN_AVAILABLE_MB }, 'warm-leads worker ready')

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down warm-leads worker (waiting for the company in flight)')
    await loop.stop().catch(() => undefined)
    await disconnect().catch(() => undefined)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'warm-leads worker failed to start')
  process.exit(1)
})
