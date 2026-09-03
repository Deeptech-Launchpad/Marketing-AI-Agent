import { env } from '../config/env.js'
import { FakeLlm } from './fake/fakeLlm.js'
import { GeminiGateway } from './gemini/geminiGateway.js'
import type { LlmPort } from './llmPort.js'

// Single place where the LLM implementation is chosen. Nothing else imports a
// concrete gateway, so the API key has exactly one call site in the process.

let instance: LlmPort | null = null

export function getLlm(): LlmPort {
  if (!instance) {
    instance = env.LLM_DRIVER === 'fake' ? new FakeLlm() : new GeminiGateway()
  }
  return instance
}

/** Test seam. */
export function setLlm(port: LlmPort | null): void {
  instance = port
}

export type { LlmPort }
