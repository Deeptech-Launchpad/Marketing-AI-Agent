import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FIELD_MAP,
  MAPPING_VERSION,
  OPEN_DECISIONS,
  PAYLOAD_VERSION,
  blockedMappings,
  externalKey,
  writableMappings,
} from '../../src/crmsync/mapping.js'
import { NxtSalesSyncProvider } from '../../src/crmsync/providers/nxtSalesProvider.js'
import { OutboxSyncProvider } from '../../src/crmsync/providers/outboxProvider.js'
import { isRetryable, PERMANENT_ERRORS, RETRYABLE_ERRORS } from '../../src/crmsync/types.js'

// TASK #986 unit tests.
//
// The properties a CRM handoff must have: it never claims a write it did not
// make, it never bypasses the port, the mapping is versioned and honest about
// what it cannot do, and retries are bounded to failures that retrying could
// actually fix.

describe('the field map', () => {
  it('is versioned', () => {
    expect(MAPPING_VERSION).toBe('crm-map-1')
    expect(PAYLOAD_VERSION).toBe('crm-payload-1')
  })

  it('marks exactly the two confirmed Company fields as writable', () => {
    // CHANGED BY VERIFIED FACT — these two custom fields were confirmed
    // present and enabled on the LIVE Company record:
    //   Intent Score          Number     key intentScore
    //   Qualification Status  Dropdown   key qualificationStatus
    //
    // They are absent from the local restored snapshot, which predates them;
    // the live application is the source of truth. Everything else stays
    // blocked, so this asserts the exact set — a third entry quietly becoming
    // writable fails here rather than reaching the CRM.
    expect(writableMappings().map((m) => m.target).sort()).toEqual([
      'Company.customField:intentScore',
      'Company.customField:qualificationStatus',
    ])
  })

  it('still refuses everything NXT Sales has no home for', () => {
    // No Lead object, no Task object, and no agreed target for the rest.
    expect(blockedMappings().length).toBeGreaterThan(5)
  })

  it('never marks the owner or a Deal field writable', () => {
    const writableTargets = writableMappings().map((m) => m.target)
    expect(writableTargets).not.toContain('Company.ownerId')
    expect(writableTargets.some((t) => /Deal/.test(t))).toBe(false)
    // Company.leadStatus is the pipeline field salespeople maintain; the
    // qualification goes to its own custom field instead.
    expect(writableTargets).not.toContain('Company.leadStatus')
  })

  it('gives every mapping a source, a target and a disposition', () => {
    for (const m of FIELD_MAP) {
      expect(m.source).toBeTruthy()
      expect(m.target).toBeTruthy()
      expect(['write', 'read_only_reference', 'blocked_no_target_field']).toContain(m.disposition)
    }
  })

  it('explains every blocked mapping', () => {
    for (const m of blockedMappings()) {
      expect(m.note, `${m.source} is blocked with no explanation`).toBeTruthy()
      expect(m.note!.length).toBeGreaterThan(30)
    }
  })

  it('surfaces the decisions it cannot make', () => {
    expect(OPEN_DECISIONS.length).toBeGreaterThan(5)
    expect(OPEN_DECISIONS.join(' ')).toMatch(/no Lead object and no Task object/i)
  })

  it('does not silently drive the CRM lead status or account owner', () => {
    // Both would overwrite fields salespeople maintain by hand.
    const leadStatus = FIELD_MAP.find((m) => m.target === 'Company.leadStatus')!
    const owner = FIELD_MAP.find((m) => m.target === 'Company.ownerId')!
    expect(leadStatus.disposition).toBe('blocked_no_target_field')
    expect(owner.disposition).toBe('blocked_no_target_field')
  })
})

describe('the correlation key', () => {
  it('is stable for the same lead', () => {
    expect(externalKey('t1', 'c1', 'q1')).toBe(externalKey('t1', 'c1', 'q1'))
  })

  it('is scoped by tenant, so two tenants cannot collide on a company id', () => {
    expect(externalKey('t1', 'c1', 'q1')).not.toBe(externalKey('t2', 'c1', 'q1'))
  })

  it('distinguishes two qualifications of the same company', () => {
    expect(externalKey('t1', 'c1', 'q1')).not.toBe(externalKey('t1', 'c1', 'q2'))
  })
})

describe('the NXT Sales provider', () => {
  const provider = new NxtSalesSyncProvider()

  it('reports write_not_supported, with a precise reason', () => {
    const a = provider.availability()
    expect(a.status).toBe('write_not_supported')
    expect(a.reason).toMatch(/exposes no write method/i)
    // The distinction that matters: the API can write; we have no path to it.
    expect(a.reason).toMatch(/NXT Sales API does have write endpoints/i)
  })

  it('gives an actionable remediation that forbids the shortcuts', () => {
    const a = provider.availability()
    expect(a.remediation).toMatch(/Do not write to NXT Sales tables directly/i)
    expect(a.remediation).toMatch(/do not add a second HTTP client/i)
  })

  it('can read but not create or update', () => {
    const c = provider.capabilities()
    expect(c.canLookup).toBe(true)
    expect(c.canCreate).toBe(false)
    expect(c.canUpdate).toBe(false)
    expect(c.canUpsert).toBe(false)
  })

  it('offers only the objects NXT Sales actually has', () => {
    // No lead, no task — those models do not exist in the CRM.
    const c = provider.capabilities()
    expect(c.resources).toEqual(['company', 'activity'])
    expect(c.resources).not.toContain('lead')
    expect(c.resources).not.toContain('task')
  })

  it('never reports a write as having happened', async () => {
    for (const outcome of [
      await provider.create('company', {} as never),
      await provider.update('company', 'x', {} as never),
      await provider.upsert('activity', {} as never),
    ]) {
      expect(outcome.result).toBe('not_supported')
      expect(outcome.externalId).toBeNull()
      expect(outcome.retryable).toBe(false)
    }
  })

  it('cannot look up by our key, because the CRM has nowhere to store one', async () => {
    expect(await provider.findExisting('mai:t:c:q')).toBeNull()
  })
})

describe('the outbox provider', () => {
  const provider = new OutboxSyncProvider()

  it('is available to HOLD, and says that is not a sync', () => {
    const a = provider.availability()
    expect(a.status).toBe('available')
    expect(a.reason).toMatch(/Nothing has been written to any CRM/i)
  })

  it('claims no write capability at all', () => {
    const c = provider.capabilities()
    expect(c.canCreate).toBe(false)
    expect(c.canUpdate).toBe(false)
    expect(c.resources).toEqual([])
  })

  it('never reports created or updated', async () => {
    const outcome = await provider.create('company')
    expect(outcome.result).toBe('not_supported')
    expect(outcome.reason).toMatch(/No CRM write was attempted/i)
  })
})

describe('retry classification', () => {
  it('retries only what retrying could fix', () => {
    for (const code of RETRYABLE_ERRORS) expect(isRetryable(code)).toBe(true)
  })

  it('never retries a permanent failure', () => {
    // Retrying a schema error burns the CRM's capacity and fills the audit
    // trail with identical failures.
    for (const code of PERMANENT_ERRORS) expect(isRetryable(code)).toBe(false)
  })

  it('treats an unknown or absent code as non-retryable', () => {
    expect(isRetryable(null)).toBe(false)
    expect(isRetryable(undefined)).toBe(false)
    expect(isRetryable('something_new')).toBe(false)
  })
})

// ── Mechanical guarantees ───────────────────────────────────────────────────

describe('structural guarantees of the CRM sync module', () => {
  const DIR = fileURLToPath(new URL('../../src/crmsync/', import.meta.url))

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...walk(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*'))
      .join('\n')
  }

  const files = walk(DIR)

  it('has source files to check', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('issues no direct SQL and opens no second HTTP client', () => {
    // The absolute rule: everything goes through CrmPort or nowhere.
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/\$executeRaw|\$queryRaw|\$executeRawUnsafe|\$queryRawUnsafe/)
      expect(src, file).not.toMatch(/\bnew\s+Pool\b|require\(['"]pg['"]\)|from ['"]pg['"]/)
      expect(src, file).not.toMatch(/fetch\s*\(|axios|got\(|undici/)
    }
  })

  it('never touches a NXT Sales table through Prisma', () => {
    // The marketing Prisma client cannot reach NXT Sales tables at all, but a
    // model name from the CRM appearing here would be a sign of confusion.
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/prisma\.(company|deal|callLog|user)\./)
    }
  })

  it('calls the CRM port for reads, plus exactly one approved write', () => {
    // CHANGED BY APPROVED SCOPE. This module was read-only until the business
    // approved a narrow write: two custom fields on Company. `updateCompany`
    // is the ONLY exception, and it is named here so a second write method
    // appearing anywhere in this module fails the test rather than shipping.
    const APPROVED_WRITE = 'updateCompany'
    const calls = new Set<string>()
    for (const file of files) {
      for (const m of code(file).matchAll(/\bcrm\.(\w+)\s*\(/g)) calls.add(m[1]!)
      for (const m of code(file).matchAll(/getCrm\(\)\.(\w+)\s*\(/g)) calls.add(m[1]!)
    }
    for (const call of calls) {
      const isRead = /^(get|list|search|export|health)/.test(call)
      expect(isRead || call === APPROVED_WRITE, `crm.${call}() is neither a read nor the approved write`).toBe(true)
    }
  })

  it('never calls a create or delete on the CRM port', () => {
    // Creating or removing a CRM record is outside the approved scope, and
    // there is no implementation to reach — this makes the absence explicit.
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/\b(crm|getCrm\(\))\.(create|delete|remove)\w*\s*\(/)
    }
  })

  it('mutates nothing owned by an earlier stage', () => {
    // CRM sync reads the whole pipeline and writes only its own three tables.
    for (const file of files) {
      const src = code(file)
      for (const model of [
        'engagementEvent',
        'intentScore',
        'intentScoreSnapshot',
        'intentScoreContribution',
        'salesQualification',
        'salesAlert',
        'salesFollowUpTask',
        'outreachAction',
        'outreachCampaign',
        'auditReport',
        'workbenchDemo',
      ]) {
        expect(src, `${file} mutates ${model}`).not.toMatch(
          new RegExp(`prisma\\.${model}\\.(create|update|delete|upsert|createMany|updateMany|deleteMany)`),
        )
      }
    }
  })

  it('executes no outreach', () => {
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/executeAction|createCampaign|composeMessage|sendEmail|sendMessage\b/)
    }
  })

  it('recalculates no score and re-qualifies nothing', () => {
    for (const file of files) {
      const src = code(file)
      expect(src, file).not.toMatch(/scoreCompany|calculateScore|evaluateCompany|decide\(/)
    }
  })

  it('never writes qualification history', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/salesQualificationHistory\./)
    }
  })

  it('keeps mapping out of the service', () => {
    // Field mapping lives in mapping.ts and payload.ts. The service orchestrates.
    const service = code(join(DIR, 'service.ts'))
    expect(service).not.toMatch(/Company\.(name|domain|industry|leadStatus|ownerId)/)
  })

  it('uses no AI model', () => {
    for (const file of files) {
      expect(code(file), file).not.toMatch(/gemini|generateContent|llmPort|getLlm/i)
    }
  })
})

describe('the language it uses', () => {
  it('never says "synced" for a package that was only prepared', () => {
    const outbox = readFileSync(
      fileURLToPath(new URL('../../src/crmsync/providers/outboxProvider.ts', import.meta.url)),
      'utf8',
    )
    expect(outbox).toMatch(/Holding a package is not delivering one/i)
    expect(outbox).not.toMatch(/result: 'created'|result: 'updated'/)
  })
})
