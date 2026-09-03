-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TenantMember" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "crmUserId" TEXT,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TenantMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdByCrmUserId" TEXT NOT NULL,
    "constraints" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Segment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "rationale" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IcpProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'medium',
    "sourceDealCount" INTEGER NOT NULL DEFAULT 0,
    "derivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IcpProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "queryUsed" JSONB NOT NULL,
    "totalMatched" INTEGER NOT NULL DEFAULT 0,
    "totalSuppressed" INTEGER NOT NULL DEFAULT 0,
    "totalIncluded" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AudienceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AudienceMember" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "crmCompanyId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "domain" TEXT,
    "industry" TEXT,
    "country" TEXT,
    "cms" TEXT,
    "ownerCrmUserId" TEXT,
    "includeReason" TEXT,
    "score" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "AudienceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'global',
    "matchType" TEXT NOT NULL,
    "matchValue" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "campaignId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdByCrmUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "requestedByCrmUserId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'dry_run',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "currentStepType" TEXT,
    "feedback" TEXT,
    "budgetTokens" INTEGER NOT NULL,
    "budgetUsd" DECIMAL(12,4) NOT NULL,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStep" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "input" JSONB,
    "output" JSONB,
    "tokensUsed" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolCall" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT,
    "toolName" TEXT NOT NULL,
    "sideEffectClass" TEXT NOT NULL,
    "args" JSONB,
    "resultSummary" JSONB,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmCall" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT,
    "stepId" TEXT,
    "feature" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'gemini',
    "modelRequested" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "fellBack" BOOLEAN NOT NULL DEFAULT false,
    "promptTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "totalTokens" INTEGER NOT NULL DEFAULT 0,
    "hasUsageData" BOOLEAN NOT NULL DEFAULT true,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "priced" BOOLEAN NOT NULL DEFAULT false,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "promptKey" TEXT,
    "promptVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPrompt" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "key" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "label" TEXT NOT NULL,
    "systemInstruction" TEXT NOT NULL,
    "userTemplate" TEXT NOT NULL,
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.4,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignStrategy" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "channelMix" JSONB NOT NULL,
    "messagingPillars" JSONB NOT NULL,
    "sequence" JSONB NOT NULL,
    "kpis" JSONB NOT NULL,
    "rationale" TEXT NOT NULL,
    "citations" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignStrategy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "assetType" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currentVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetVersion" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "variantLabel" TEXT NOT NULL DEFAULT 'A',
    "content" JSONB NOT NULL,
    "renderedText" TEXT NOT NULL,
    "model" TEXT,
    "promptKey" TEXT,
    "promptVersion" INTEGER,
    "citations" JSONB,
    "validationResults" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "payloadHash" TEXT NOT NULL,
    "payloadSnapshot" JSONB NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedByCrmUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "comment" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "corpusType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'upload',
    "sourceUri" TEXT,
    "mimeType" TEXT NOT NULL DEFAULT 'text/plain',
    "checksum" TEXT NOT NULL,
    "sizeChars" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "uploadedByCrmUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "sectionPath" TEXT,
    "embeddingModel" TEXT,
    "embedding" vector(768),
    "tsv" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchArtifact" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT,
    "kind" TEXT NOT NULL,
    "requestUrl" TEXT,
    "finalUrl" TEXT,
    "query" TEXT,
    "contentHash" TEXT NOT NULL,
    "extractedText" TEXT NOT NULL,
    "signals" JSONB,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "failureReason" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchArtifact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "actorCrmUserId" TEXT,
    "runId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "dataClass" TEXT NOT NULL DEFAULT 'internal',
    "summary" TEXT,
    "metadata" JSONB,
    "requestId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "TenantMember_crmUserId_idx" ON "TenantMember"("crmUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TenantMember_tenantId_email_key" ON "TenantMember"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "TenantMember_tenantId_crmUserId_key" ON "TenantMember"("tenantId", "crmUserId");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_status_idx" ON "Campaign"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Campaign_tenantId_createdAt_idx" ON "Campaign"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Segment_tenantId_campaignId_idx" ON "Segment"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "IcpProfile_tenantId_derivedAt_idx" ON "IcpProfile"("tenantId", "derivedAt");

-- CreateIndex
CREATE INDEX "AudienceSnapshot_tenantId_segmentId_idx" ON "AudienceSnapshot"("tenantId", "segmentId");

-- CreateIndex
CREATE INDEX "AudienceMember_tenantId_crmCompanyId_idx" ON "AudienceMember"("tenantId", "crmCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "AudienceMember_snapshotId_crmCompanyId_key" ON "AudienceMember"("snapshotId", "crmCompanyId");

-- CreateIndex
CREATE INDEX "SuppressionEntry_tenantId_matchType_idx" ON "SuppressionEntry"("tenantId", "matchType");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_tenantId_scope_matchType_matchValue_key" ON "SuppressionEntry"("tenantId", "scope", "matchType", "matchValue");

-- CreateIndex
CREATE INDEX "AgentRun_tenantId_status_idx" ON "AgentRun"("tenantId", "status");

-- CreateIndex
CREATE INDEX "AgentRun_tenantId_createdAt_idx" ON "AgentRun"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentStep_runId_type_idx" ON "AgentStep"("runId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_runId_seq_key" ON "AgentStep"("runId", "seq");

-- CreateIndex
CREATE INDEX "ToolCall_runId_createdAt_idx" ON "ToolCall"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolCall_tenantId_toolName_idx" ON "ToolCall"("tenantId", "toolName");

-- CreateIndex
CREATE INDEX "LlmCall_tenantId_createdAt_idx" ON "LlmCall"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "LlmCall_runId_idx" ON "LlmCall"("runId");

-- CreateIndex
CREATE INDEX "AgentPrompt_key_enabled_idx" ON "AgentPrompt"("key", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPrompt_tenantId_key_version_key" ON "AgentPrompt"("tenantId", "key", "version");

-- CreateIndex
CREATE INDEX "CampaignStrategy_campaignId_version_idx" ON "CampaignStrategy"("campaignId", "version");

-- CreateIndex
CREATE INDEX "Asset_campaignId_channel_idx" ON "Asset"("campaignId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "AssetVersion_assetId_version_variantLabel_key" ON "AssetVersion"("assetId", "version", "variantLabel");

-- CreateIndex
CREATE INDEX "Approval_tenantId_status_idx" ON "Approval"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Approval_runId_idx" ON "Approval"("runId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_tenantId_corpusType_status_idx" ON "KnowledgeDocument"("tenantId", "corpusType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_tenantId_checksum_key" ON "KnowledgeDocument"("tenantId", "checksum");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tenantId_idx" ON "KnowledgeChunk"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_documentId_seq_key" ON "KnowledgeChunk"("documentId", "seq");

-- CreateIndex
CREATE INDEX "ResearchArtifact_tenantId_kind_expiresAt_idx" ON "ResearchArtifact"("tenantId", "kind", "expiresAt");

-- CreateIndex
CREATE INDEX "ResearchArtifact_contentHash_idx" ON "ResearchArtifact"("contentHash");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_createdAt_idx" ON "AuditEvent"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_tenantId_action_idx" ON "AuditEvent"("tenantId", "action");

-- AddForeignKey
ALTER TABLE "TenantMember" ADD CONSTRAINT "TenantMember_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Segment" ADD CONSTRAINT "Segment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceSnapshot" ADD CONSTRAINT "AudienceSnapshot_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "Segment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AudienceMember" ADD CONSTRAINT "AudienceMember_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "AudienceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolCall" ADD CONSTRAINT "ToolCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmCall" ADD CONSTRAINT "LlmCall_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignStrategy" ADD CONSTRAINT "CampaignStrategy_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetVersion" ADD CONSTRAINT "AssetVersion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

