import { prisma } from '../platform/db.js'
import { NotFoundError } from '../platform/errors.js'

// Prompts live in the database, versioned, not in code.
//
// This is a direct evolution of NXT Sales' PromptTemplate: same {{variable}}
// substitution convention, same isSystem protection on the built-ins so a
// prompt the orchestrator still needs cannot be deleted out from under it.
// The resolved (key, version) is recorded on every LlmCall and AssetVersion,
// so any output can be traced back to the exact prompt that produced it.

export interface ResolvedPrompt {
  key: string
  version: number
  systemInstruction: string
  userText: string
  temperature: number
}

/**
 * Substitutes {{name}} placeholders. An unknown placeholder is left intact
 * rather than replaced with "undefined" — a visible {{gap}} in a prompt is a
 * bug someone will notice; the string "undefined" is one they will not.
 */
export function render(template: string, variables: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, name: string) => {
    const value = variables[name]
    if (value === undefined || value === null) return match
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  })
}

/** Highest enabled version for a key. Tenant-specific rows win over global. */
export async function resolvePrompt(
  key: string,
  variables: Record<string, unknown>,
  tenantId?: string,
): Promise<ResolvedPrompt> {
  const row =
    (tenantId
      ? await prisma.agentPrompt.findFirst({
          where: { key, enabled: true, tenantId },
          orderBy: { version: 'desc' },
        })
      : null) ??
    (await prisma.agentPrompt.findFirst({
      where: { key, enabled: true, tenantId: null },
      orderBy: { version: 'desc' },
    }))

  if (!row) throw new NotFoundError(`No enabled prompt found for key "${key}". Run npm run db:seed.`)

  return {
    key: row.key,
    version: row.version,
    systemInstruction: row.systemInstruction,
    userText: render(row.userTemplate, variables),
    temperature: row.temperature,
  }
}
