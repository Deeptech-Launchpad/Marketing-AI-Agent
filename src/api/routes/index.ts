import { Router } from 'express'
import { authenticate } from '../middleware/auth.js'
import { adminRoutes } from './admin.routes.js'
import { authRoutes } from './auth.routes.js'
import { approvalRoutes } from './approvals.routes.js'
import { auditApprovalRoutes } from './auditApproval.routes.js'
import { campaignRoutes } from './campaigns.routes.js'
import { companyRoutes } from './companies.routes.js'
import { decisionMakerRoutes } from './decisionMakers.routes.js'
import { enrichmentRoutes } from './enrichment.routes.js'
import { intentRoutes } from './intent.routes.js'
import { knowledgeRoutes } from './knowledge.routes.js'
import { engagementRoutes } from './engagement.routes.js'
import { intentScoreRoutes } from './intentScore.routes.js'
import { crmSyncRoutes } from './crmSync.routes.js'
import { salesQualificationRoutes } from './salesQualification.routes.js'
import { outreachRoutes } from './outreach.routes.js'
import { outreachSequenceRoutes } from './outreachSequence.routes.js'
import { bulkEmailRoutes } from './bulkEmail.routes.js'
import { prospectRoutes } from './prospects.routes.js'
import { companyDiscoveryRoutes } from './companyDiscovery.routes.js'
import { crmLeadsRoutes } from './crmLeads.routes.js'
import { usageRoutes } from './usage.routes.js'
import { runRoutes } from './runs.routes.js'
import { segmentRoutes } from './segments.routes.js'
import { websiteAuditRoutes } from './websiteAudit.routes.js'
import { workbenchRoutes } from './workbench.routes.js'

// Everything under /api/v1 is authenticated. Health lives outside this router
// so a readiness probe does not need a token.

export const apiRoutes = Router()

// EXCEPT signing in, which happens before there is a token to present. These
// are the only unauthenticated routes here, they are rate-limited on their own
// terms, and they grant no access by themselves — what an account may DO is
// still decided by its TenantMember role, below.
apiRoutes.use('/auth', authRoutes)

apiRoutes.use(authenticate)

apiRoutes.get('/me', (req, res) => {
  const p = req.principal!
  res.json({
    crmUserId: p.crmUserId,
    email: p.email,
    name: p.name,
    tenantId: p.tenantId,
    role: p.role,
    permissions: p.permissions,
  })
})

apiRoutes.use('/campaigns', campaignRoutes)
// Read-only company lookup against the customer's own CRM, for the picker.
apiRoutes.use('/companies', companyRoutes)
apiRoutes.use('/runs', runRoutes)
apiRoutes.use('/approvals', approvalRoutes)
apiRoutes.use('/prospects', prospectRoutes)
// Stage 1b — open-web company discovery ("Find New Company"). Additive to
// /prospects, which stays CRM-only by design.
apiRoutes.use('/company-discovery', companyDiscoveryRoutes)
apiRoutes.use('/crm-leads', crmLeadsRoutes)
// Read-only reporting on what this platform spent against its own API keys.
apiRoutes.use('/usage', usageRoutes)
apiRoutes.use('/enrichment', enrichmentRoutes)
apiRoutes.use('/intent', intentRoutes)
apiRoutes.use('/decision-makers', decisionMakerRoutes)
apiRoutes.use('/website-audit', websiteAuditRoutes)
// Task #980 rides the same prefix so the paths a future UI calls stay in one
// namespace, while the approval workflow stays in its own module.
apiRoutes.use('/website-audit', auditApprovalRoutes)
// Task #981 shares the prefix too: a Workbench is addressed by its audit run.
apiRoutes.use('/website-audit', workbenchRoutes)
// The Sales-approved sequence, mounted before the legacy routes it sits beside.
apiRoutes.use('/outreach/sequence', outreachSequenceRoutes)
apiRoutes.use('/outreach/bulk', bulkEmailRoutes)
apiRoutes.use('/outreach', outreachRoutes)
apiRoutes.use('/engagement', engagementRoutes)
apiRoutes.use('/intent-score', intentScoreRoutes)
apiRoutes.use('/sales-qualification', salesQualificationRoutes)
apiRoutes.use('/crm-sync', crmSyncRoutes)
apiRoutes.use('/segments', segmentRoutes)
apiRoutes.use('/knowledge', knowledgeRoutes)
apiRoutes.use('/admin', adminRoutes)
