import express from 'express'
import rateLimit from 'express-rate-limit'
import helmet from 'helmet'
import { pinoHttp } from 'pino-http'
import { env } from './config/env.js'
import { logger } from './platform/logger.js'
import { errorHandler, notFound } from './api/middleware/errorHandler.js'
import { requestId } from './api/middleware/requestId.js'
import { apiRoutes } from './api/routes/index.js'
import { engagementWebhookRoutes } from './api/routes/engagementWebhook.routes.js'
import { healthRoutes } from './api/routes/health.routes.js'
import { publicWorkbenchRoutes } from './api/routes/publicWorkbench.routes.js'

export function createServer() {
  const app = express()

  app.disable('x-powered-by')

  // WHO IS CALLING — BEHIND NGINX (2026-10-06).
  //
  // In production every browser request reaches this process through nginx on
  // the same machine, so the connection always comes from 127.0.0.1 and the
  // caller's real address is in X-Forwarded-For. Without this setting every
  // user looked like the same caller: the rate limits below were one bucket
  // for the whole company, so a handful of mistyped codes — or ten people
  // signing up in one hour — locked everyone out of signing in.
  //
  // 'loopback' trusts that header ONLY when the connection itself comes from
  // this machine. The API port is also reachable directly, and a request made
  // straight to it from outside keeps its real address: it cannot pick its own
  // by sending the header, so it cannot slip past a limit that way.
  app.set('trust proxy', 'loopback')

  app.use(helmet())
  app.use(requestId)
  app.use(
    pinoHttp({
      logger,
      customProps: (req: express.Request) => ({ requestId: req.requestId }),
      autoLogging: { ignore: (req: { url?: string }) => req.url?.startsWith('/health') ?? false },
    }),
  )

  // Modest limit: this is an internal service whose callers are humans and a
  // future UI, not a public API. NXT Sales has no rate limiting at all, which
  // is one of the reasons the CRM client throttles itself on the way out.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-7',
      legacyHeaders: false,
    }),
  )

  // Knowledge documents are posted as JSON text, so the body limit has to be
  // comfortably above KNOWLEDGE_MAX_UPLOAD_CHARS.
  //
  // Task #983: `verify` keeps the exact bytes received. An HMAC has to be
  // checked against what the provider actually signed — re-serialising the
  // parsed object would change key order and whitespace and fail every valid
  // signature.
  app.use(
    express.json({
      limit: '10mb',
      verify: (req, _res, buf) => {
        if (buf.length <= 1_000_000) (req as express.Request).rawBody = buf.toString('utf8')
      },
    }),
  )

  app.use(healthRoutes)

  // Task #983: the provider webhook boundary. Unauthenticated by necessity —
  // a provider cannot hold one of our JWTs — and therefore gated on a signature
  // instead. Mounted before /api/v1 for the same reason as the Workbench.
  app.use(engagementWebhookRoutes)

  // Task #981: the ONLY unauthenticated surface. Mounted before /api/v1 with
  // its own rate limit, its own CSP, and a urlencoded body parser scoped to it
  // so the registration form works without JavaScript. It reads nothing but a
  // token and emits no internal identifier.
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))
  app.use(publicWorkbenchRoutes)

  app.use('/api/v1', apiRoutes)

  app.use(notFound)
  app.use(errorHandler)

  return app
}

export function startServer() {
  const app = createServer()
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, crmDriver: env.CRM_DRIVER, llmDriver: env.LLM_DRIVER, mode: env.DEFAULT_RUN_MODE },
      'marketing-agent API listening',
    )
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error({ port: env.PORT }, 'port already in use')
      process.exit(1)
    }
    throw err
  })

  return server
}
