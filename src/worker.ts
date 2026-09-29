import { runDecisionMakerDiscovery } from './decisionmakers/discovery.js'
import { runCompanyEnrichment } from './enrichment/companyEnrichment.js'
import { runIntentDetection } from './intent/intentDetection.js'
import { processDocument } from './knowledge/ingest.js'
import { runProspectDiscovery } from './prospects/prospectDiscovery.js'
import { runCompanyWebDiscovery } from './prospects/companyWebDiscovery.js'
import { executeAction } from './outreach/engine.js'
import { scoreCompany } from './intentscore/service.js'
import { evaluateCompany } from './salesqualification/service.js'
import { syncQualification } from './crmsync/service.js'
import { runWebsiteAudit } from './websiteaudit/audit.js'
import { executeNextStep } from './orchestrator/runner.js'
import { disconnect } from './platform/db.js'
import { logger } from './platform/logger.js'
import {
  QUEUE_COMPANY_ENRICH,
  QUEUE_COMPANY_WEB_DISCOVER,
  QUEUE_CRM_SYNC,
  QUEUE_DM_DISCOVER,
  QUEUE_DM_LEAD_WATCH,
  QUEUE_INTENT_DETECT,
  QUEUE_INTENT_SCORE,
  QUEUE_KNOWLEDGE_INGEST,
  QUEUE_OUTREACH_ACTION,
  QUEUE_OUTREACH_TEST_DISPATCH,
  QUEUE_PROSPECT_DISCOVER,
  QUEUE_QUALIFICATION_EVALUATE,
  QUEUE_RUN_STEP,
  QUEUE_WEBSITE_AUDIT,
  getQueue,
  stopQueue,
  work,
} from './platform/queue.js'
import { checkForNewLeads } from './decisionmakers/leadWatch.js'
import { dispatchTestSends } from './outreach/salesSequence/sending/dispatcher.js'
import { env } from './config/env.js'

// Worker entrypoint.
//
// Every unit of agent work arrives here as a durable job. A crash mid-step
// redelivers the job and the run resumes from its last persisted step — the
// property that in-memory setInterval jobs structurally cannot have.

async function main() {
  await work(QUEUE_RUN_STEP, async (data) => {
    const runId = String(data.runId ?? '')
    if (!runId) return
    await executeNextStep(runId)
  })

  await work(QUEUE_KNOWLEDGE_INGEST, async (data) => {
    const documentId = String(data.documentId ?? '')
    if (!documentId) return
    await processDocument(documentId)
  })

  await work(QUEUE_PROSPECT_DISCOVER, async (data) => {
    const searchId = String(data.searchId ?? '')
    if (!searchId) return
    await runProspectDiscovery(searchId)
  })

  await work(QUEUE_COMPANY_WEB_DISCOVER, async (data) => {
    const searchId = String(data.searchId ?? '')
    if (!searchId) return
    await runCompanyWebDiscovery(searchId)
  })

  await work(QUEUE_COMPANY_ENRICH, async (data) => {
    const enrichmentId = String(data.enrichmentId ?? '')
    if (!enrichmentId) return
    await runCompanyEnrichment(enrichmentId)
  })

  await work(QUEUE_INTENT_DETECT, async (data) => {
    const intentRunId = String(data.intentRunId ?? '')
    if (!intentRunId) return
    await runIntentDetection(intentRunId)
  })

  await work(QUEUE_DM_DISCOVER, async (data) => {
    const dmRunId = String(data.dmRunId ?? '')
    if (!dmRunId) return
    await runDecisionMakerDiscovery(dmRunId)
  })

  await work(QUEUE_WEBSITE_AUDIT, async (data) => {
    const auditRunId = String(data.auditRunId ?? '')
    if (!auditRunId) return
    await runWebsiteAudit(auditRunId)
  })

  await work(QUEUE_OUTREACH_ACTION, async (data) => {
    const actionId = String(data.actionId ?? '')
    if (!actionId) return
    // executeAction re-checks suppression, provider availability and validation
    // before anything happens, so a redelivered job cannot act on stale state —
    // and a terminal action returns its existing result rather than sending
    // twice.
    await executeAction(actionId)
  })

  // TASK #984: recalculate one company's intent score.
  //
  // The job carries only a company reference. Everything else — the events, the
  // policy, the evaluation instant — is resolved inside the calculation, so a
  // redelivered job recomputes from current state rather than replaying a
  // stale payload. Recalculation is idempotent: an identical result adds no
  // history row, so a retry cannot inflate the record.
  //
  // Scoring never writes an EngagementEvent, so this cannot trigger the event
  // that triggered it.
  await work(QUEUE_INTENT_SCORE, async (data) => {
    const tenantId = String(data.tenantId ?? '')
    const crmCompanyId = String(data.crmCompanyId ?? '')
    if (!tenantId || !crmCompanyId) return

    const trigger = String(data.trigger ?? 'event_ingested')
    const result = await scoreCompany({
      tenantId,
      crmCompanyId,
      trigger: trigger === 'policy_change' ? 'policy_change' : 'event_ingested',
    })

    logger.info(
      {
        crmCompanyId,
        score: result.normalizedScore,
        level: result.level,
        policyVersion: result.policyVersion,
        unchanged: result.unchanged,
      },
      'intent score recalculated',
    )
  })

  // TASK #985: evaluate one company against the qualification threshold, and
  // hand it to a person if it passes.
  //
  // The job carries only a company reference. The score, the threshold and the
  // owner are all loaded server-side from trusted records, so a redelivered or
  // tampered job cannot mark a company hot by asserting it.
  //
  // Safe to redeliver: the alert and the task are unique on an idempotency key,
  // so a retry converges on the existing rows rather than telling a salesperson
  // about the same lead twice.
  await work(QUEUE_QUALIFICATION_EVALUATE, async (data) => {
    const tenantId = String(data.tenantId ?? '')
    const crmCompanyId = String(data.crmCompanyId ?? '')
    if (!tenantId || !crmCompanyId) return

    const result = await evaluateCompany({ tenantId, crmCompanyId })

    logger.info(
      {
        crmCompanyId,
        status: result.status,
        score: result.score,
        threshold: result.threshold,
        ownerSource: result.owner.source,
        alertStatus: result.alertStatus,
        taskStatus: result.taskStatus,
        unchanged: result.unchanged,
      },
      'sales qualification evaluated',
    )
  })

  // TASK #986: hand a qualified lead to the CRM.
  //
  // The job carries only a qualification reference. The score, the owner, the
  // company and the approved audit are all loaded server-side, so a tampered
  // job cannot push an unqualified prospect into the CRM by asserting it.
  //
  // Safe to redeliver: a completed handoff is returned rather than repeated,
  // and an undelivered package is refreshed in the outbox rather than stacked.
  //
  // CRM sync writes only its own tables, so it cannot produce an engagement
  // event that would start this chain again.
  await work(QUEUE_CRM_SYNC, async (data) => {
    const tenantId = String(data.tenantId ?? '')
    const qualificationId = String(data.qualificationId ?? '')
    if (!tenantId || !qualificationId) return

    const result = await syncQualification({ tenantId, qualificationId })

    logger.info(
      {
        qualificationId,
        crmCompanyId: result.crmCompanyId,
        state: result.state,
        provider: result.providerName,
        providerStatus: result.providerStatus,
        mappingVersion: result.mappingVersion,
        attempt: result.attempt,
        outboxId: result.outboxId,
      },
      'crm sync processed',
    )
  })

  // New lead → decision-maker discovery. A durable pg-boss schedule rather than
  // a timer, so only one check runs per interval however many workers exist,
  // and turning the flag off removes the schedule instead of leaving it behind.
  await work(QUEUE_DM_LEAD_WATCH, async () => {
    await checkForNewLeads()
  })
  const boss = await getQueue()
  if (env.DM_AUTO_DISCOVER_ENABLED) {
    await boss.schedule(QUEUE_DM_LEAD_WATCH, `*/${env.DM_AUTO_DISCOVER_INTERVAL_MINUTES} * * * *`)
  } else {
    await boss.unschedule(QUEUE_DM_LEAD_WATCH)
  }

  // TEST MODE outreach sender (2026-09-28): approved test-batch emails go to the
  // internal test inboxes at their scheduled time. Off → no schedule at all.
  await work(QUEUE_OUTREACH_TEST_DISPATCH, async () => {
    await dispatchTestSends()
  })
  if (env.OUTREACH_EMAIL_MODE === 'test') {
    await boss.schedule(QUEUE_OUTREACH_TEST_DISPATCH, `*/${env.OUTREACH_TEST_DISPATCH_INTERVAL_MINUTES} * * * *`)
  } else {
    await boss.unschedule(QUEUE_OUTREACH_TEST_DISPATCH)
  }

  logger.info(
    {
      autoDecisionMakerDiscovery: env.DM_AUTO_DISCOVER_ENABLED
        ? `every ${env.DM_AUTO_DISCOVER_INTERVAL_MINUTES} min`
        : 'off',
      outreachEmailMode: env.OUTREACH_EMAIL_MODE === 'test' ? `test (every ${env.OUTREACH_TEST_DISPATCH_INTERVAL_MINUTES} min, internal inboxes only)` : 'off',
      queues: [
        QUEUE_RUN_STEP,
        QUEUE_KNOWLEDGE_INGEST,
        QUEUE_PROSPECT_DISCOVER,
        QUEUE_COMPANY_ENRICH,
        QUEUE_INTENT_DETECT,
        QUEUE_DM_DISCOVER,
        QUEUE_WEBSITE_AUDIT,
        QUEUE_OUTREACH_ACTION,
        QUEUE_INTENT_SCORE,
        QUEUE_QUALIFICATION_EVALUATE,
        QUEUE_CRM_SYNC,
      ],
    },
    'marketing-agent worker ready',
  )

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await stopQueue().catch(() => undefined)
    await disconnect().catch(() => undefined)
    process.exit(0)
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start')
  process.exit(1)
})
