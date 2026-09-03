import pino from 'pino'
import { env } from '../config/env.js'

// Secrets must never reach a log line, an HTTP response, or an error message.
// pino redaction is the backstop; the gateway and CRM client additionally never
// place a key into an error string in the first place.
const REDACT = [
  'req.headers.authorization',
  'req.headers.cookie',
  'apiKey',
  'key',
  '*.apiKey',
  '*.authorization',
  'GEMINI_API_KEY',
  'JWT_SECRET',
]

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT, censor: '[redacted]' },
  base: { service: 'marketing-agent' },
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
})

export type Logger = typeof logger

/** Child logger bound to a run, so every line of a run is greppable by runId. */
export function runLogger(runId: string, extra: Record<string, unknown> = {}) {
  return logger.child({ runId, ...extra })
}
