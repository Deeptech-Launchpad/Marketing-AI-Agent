import { disconnect } from './platform/db.js'
import { logger } from './platform/logger.js'
import { getQueue, stopQueue } from './platform/queue.js'
import { startServer } from './server.js'

// API entrypoint. The worker runs as a SEPARATE process (src/worker.ts) so a
// long step cannot make the API unresponsive — the failure mode this whole
// service exists to avoid inside NXT Sales' single process.

async function main() {
  // Ensures the queue schema and queues exist before the first request tries
  // to enqueue anything.
  await getQueue()
  const server = startServer()

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down API')
    server.close()
    await stopQueue().catch(() => undefined)
    await disconnect().catch(() => undefined)
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'API failed to start')
  process.exit(1)
})
