import { z } from 'zod'
import type { SideEffectClass, StepType } from '../../domain/enums.js'

// The tool registry.
//
// PHASE 1 CONTAINS NO WRITE TOOLS. Not "present but disabled" — they do not
// exist, and CrmPort has no write methods for them to call. That is the
// strongest available guarantee that a Phase 1 run cannot alter NXT Sales data
// or reach the outside world, and it holds regardless of what any model says.
//
// `allowedInSteps` is the other half of the injection firewall: a tool is only
// dispatchable from the steps it belongs to, so untrusted text read during
// RESEARCH cannot reach a CRM tool even if the model asked for one.

export type TrustLevel = 'trusted' | 'untrusted'

export interface ToolDefinition {
  name: string
  description: string
  argsSchema: z.ZodType<unknown>
  sideEffectClass: SideEffectClass
  allowedInSteps: StepType[]
  /** Whether the tool's OUTPUT may be treated as authoritative in a prompt. */
  outputTrust: TrustLevel
  timeoutMs: number
}

const empty = z.object({}).strict()

export const TOOLS: Record<string, ToolDefinition> = {
  'crm.searchCompanies': {
    name: 'crm.searchCompanies',
    description: 'Paginated company search against the CRM using segment filters.',
    argsSchema: z.object({ query: z.record(z.unknown()) }),
    sideEffectClass: 'read',
    allowedInSteps: ['SEGMENT_RESOLVE'],
    outputTrust: 'trusted',
    timeoutMs: 20_000,
  },
  'crm.exportCompanies': {
    name: 'crm.exportCompanies',
    description: 'Full unpaginated company set for an audience snapshot.',
    argsSchema: z.object({ query: z.record(z.unknown()) }),
    sideEffectClass: 'read',
    allowedInSteps: ['SEGMENT_RESOLVE'],
    outputTrust: 'trusted',
    timeoutMs: 30_000,
  },
  'crm.getCompany': {
    name: 'crm.getCompany',
    description: 'One company by id, for personalisation context.',
    argsSchema: z.object({ id: z.string().min(1) }),
    sideEffectClass: 'read',
    // Deliberately NOT available in RESEARCH. That step reads untrusted page
    // content, and it already has the company data it needs from the local
    // audience snapshot — so there is no reason to leave a CRM route open
    // from the one step where injected instructions can appear.
    allowedInSteps: ['CONTENT_GENERATE'],
    outputTrust: 'trusted',
    timeoutMs: 15_000,
  },
  'crm.exportDeals': {
    name: 'crm.exportDeals',
    description: 'All deals, for ICP derivation.',
    argsSchema: empty,
    sideEffectClass: 'read',
    allowedInSteps: ['ICP_SYNTHESIS', 'SEGMENT_RESOLVE'],
    outputTrust: 'trusted',
    timeoutMs: 30_000,
  },
  'crm.getDealStats': {
    name: 'crm.getDealStats',
    description: 'Pipeline aggregates from the CRM dashboard endpoint.',
    argsSchema: z.object({ year: z.number().optional(), month: z.number().optional() }),
    sideEffectClass: 'read',
    allowedInSteps: ['ICP_SYNTHESIS'],
    outputTrust: 'trusted',
    timeoutMs: 15_000,
  },
  'crm.getEmailSummary': {
    name: 'crm.getEmailSummary',
    description: 'Thread-grouped email history for one company.',
    argsSchema: z.object({ companyId: z.string().min(1) }),
    sideEffectClass: 'read',
    allowedInSteps: ['CONTENT_GENERATE'],
    // Third parties wrote this text. It is delimited as untrusted in prompts.
    outputTrust: 'untrusted',
    timeoutMs: 15_000,
  },
  'crm.getDropdownOptions': {
    name: 'crm.getDropdownOptions',
    description: 'Legal values for a CRM dropdown field — the segment vocabulary.',
    argsSchema: z.object({ fieldKey: z.string().min(1) }),
    sideEffectClass: 'read',
    allowedInSteps: ['SEGMENT_PROPOSE'],
    outputTrust: 'trusted',
    timeoutMs: 10_000,
  },
  'crm.getCustomFieldDefs': {
    name: 'crm.getCustomFieldDefs',
    description: 'Tenant-specific custom field definitions.',
    argsSchema: z.object({ entity: z.enum(['Company', 'Deal']) }),
    sideEffectClass: 'read',
    allowedInSteps: ['SEGMENT_PROPOSE'],
    outputTrust: 'trusted',
    timeoutMs: 10_000,
  },
  'rag.search': {
    name: 'rag.search',
    description: 'Retrieve cited chunks from the marketing knowledge base.',
    argsSchema: z.object({
      query: z.string().min(1),
      corpusTypes: z.array(z.string()).optional(),
      topN: z.number().int().positive().max(20).optional(),
    }),
    sideEffectClass: 'read',
    allowedInSteps: ['ICP_SYNTHESIS', 'STRATEGY', 'CONTENT_GENERATE', 'CONTENT_VALIDATE'],
    outputTrust: 'trusted',
    timeoutMs: 20_000,
  },
  'research.webSearch': {
    name: 'research.webSearch',
    description: 'Web search. Returns unavailable until a provider is configured.',
    argsSchema: z.object({ query: z.string().min(1) }),
    sideEffectClass: 'read',
    allowedInSteps: ['RESEARCH'],
    outputTrust: 'untrusted',
    timeoutMs: 20_000,
  },
  'research.fetchPage': {
    name: 'research.fetchPage',
    description: 'SSRF-guarded fetch of one public web page, reduced to text and platform signals.',
    argsSchema: z.object({ url: z.string().min(1) }),
    sideEffectClass: 'read',
    allowedInSteps: ['RESEARCH'],
    outputTrust: 'untrusted',
    timeoutMs: 20_000,
  },
}

export function getTool(name: string): ToolDefinition | null {
  // Exact lookup against a static map — never dynamic property access from a
  // model-supplied string that could reach a prototype member.
  return Object.prototype.hasOwnProperty.call(TOOLS, name) ? TOOLS[name]! : null
}

export function toolNames(): string[] {
  return Object.keys(TOOLS)
}
