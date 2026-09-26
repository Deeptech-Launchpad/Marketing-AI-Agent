import 'dotenv/config'
import { runProspectDiscovery } from '../src/prospects/prospectDiscovery.js'
import { runCompanyEnrichment } from '../src/enrichment/companyEnrichment.js'
import { runIntentDetection } from '../src/intent/intentDetection.js'
import { runDecisionMakerDiscovery } from '../src/decisionmakers/discovery.js'
import { runWebsiteAudit } from '../src/websiteaudit/audit.js'
import { scoreCompany } from '../src/intentscore/service.js'
import { evaluateCompany } from '../src/salesqualification/service.js'
import { syncQualification } from '../src/crmsync/service.js'
import { logger } from '../src/platform/logger.js'
import {
  work,
  QUEUE_COMPANY_ENRICH,
  QUEUE_PROSPECT_DISCOVER,
  QUEUE_CRM_SYNC,
  QUEUE_DM_DISCOVER,
  QUEUE_INTENT_DETECT,
  QUEUE_INTENT_SCORE,
  QUEUE_QUALIFICATION_EVALUATE,
  QUEUE_WEBSITE_AUDIT,
} from '../src/platform/queue.js'

// THE DEMO WORKER.
//
// Identical handlers to src/worker.ts, minus one queue: run.step.
//
// WHY. The engine buttons in the UI enqueue a job and return; without a worker
// consuming that queue, "Start audit" spins forever and the demo shows nothing.
// But the full worker also drains `run.step`, and this database holds hundreds
// of orchestrator steps from earlier sessions. Running it made the backlog GROW
// — 427 jobs to 541 in forty seconds — because each old step enqueues the next.
// That is real work nobody asked for, against real providers, at real cost.
//
// Subscribing to the engine queues alone keeps the demo responsive while the
// stale orchestrator backlog stays exactly where it is, untouched and
// uncancelled. Nothing here is a reimplementation: every handler calls the same
// engine function the production worker calls.
//
// Sends stay off. outreach.action is deliberately NOT subscribed, so no message
// can leave this machine no matter what is queued.

async function main() {
  logger.info('demo worker: engine queues only (run.step and outreach.action are NOT consumed)')

  await work(QUEUE_PROSPECT_DISCOVER, async (data) => {
    const id = String(data.searchId ?? '')
    if (id) await runProspectDiscovery(id)
  })

  await work(QUEUE_COMPANY_ENRICH, async (data) => {
    const id = String(data.enrichmentId ?? '')
    if (id) await runCompanyEnrichment(id)
  })

  await work(QUEUE_INTENT_DETECT, async (data) => {
    const id = String(data.intentRunId ?? data.runId ?? '')
    if (id) await runIntentDetection(id)
  })

  await work(QUEUE_DM_DISCOVER, async (data) => {
    const id = String(data.dmRunId ?? data.runId ?? '')
    if (id) await runDecisionMakerDiscovery(id)
  })

  await work(QUEUE_WEBSITE_AUDIT, async (data) => {
    const id = String(data.auditRunId ?? data.runId ?? '')
    if (id) await runWebsiteAudit(id)
  })

  await work(QUEUE_INTENT_SCORE, async (data) => {
    const tenantId = String(data.tenantId ?? '')
    const crmCompanyId = String(data.crmCompanyId ?? '')
    if (tenantId && crmCompanyId) await scoreCompany({ tenantId, crmCompanyId })
  })

  await work(QUEUE_QUALIFICATION_EVALUATE, async (data) => {
    const tenantId = String(data.tenantId ?? '')
    const crmCompanyId = String(data.crmCompanyId ?? '')
    if (tenantId && crmCompanyId) await evaluateCompany({ tenantId, crmCompanyId })
  })

  await work(QUEUE_CRM_SYNC, async (data) => {
    const tenantId = String(data.tenantId ?? '')
    const qualificationId = String(data.qualificationId ?? '')
    // No userApproval is supplied here, exactly as in production: a queued sync
    // can only ever reach the human gate, never a write.
    if (tenantId && qualificationId) await syncQualification({ tenantId, qualificationId })
  })

  logger.info('demo worker ready')
}

main().catch((err) => {
  logger.error({ err }, 'demo worker failed to start')
  process.exit(1)
})
