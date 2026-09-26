-- 2026-09-24 RESTRUCTURE — OUTREACH NO LONGER REQUIRES AN APPROVED AUDIT.
--
-- Website Audit / Audit Report / Human Approval / AI Workbench are locked
-- (see web/src/engines/WebsiteAudit.tsx etc.) and will not produce new
-- approvals. The default path into Outreach is now Decision Makers + Intent
-- Signals (src/outreach/engine.ts, buildIntentBasis()). The LEGACY
-- auditRunId-based path is kept, unchanged, for any campaign already built
-- from an approved audit — these columns become optional, not removed.

-- AlterTable
ALTER TABLE "marketing"."OutreachCampaign" ALTER COLUMN "auditRunId" DROP NOT NULL;
ALTER TABLE "marketing"."OutreachCampaign" ALTER COLUMN "auditReportId" DROP NOT NULL;
ALTER TABLE "marketing"."OutreachCampaign" ADD COLUMN "discoveredCompanyId" TEXT;

-- DropForeignKey
ALTER TABLE "marketing"."OutreachCampaign" DROP CONSTRAINT "OutreachCampaign_auditRunId_fkey";

-- AddForeignKey
-- SetNull, not Cascade: an intent-basis campaign has nothing to cascade from,
-- and a legacy campaign whose audit run is deleted now survives with
-- auditRunId cleared rather than disappearing with it.
ALTER TABLE "marketing"."OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "marketing"."WebsiteAuditRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "OutreachCampaign_discoveredCompanyId_idx" ON "marketing"."OutreachCampaign"("discoveredCompanyId");

-- CreateTable
CREATE TABLE "marketing"."OutreachTemplate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "subjectRaw" TEXT,
    "bodyRaw" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdByCrmUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OutreachTemplate_tenantId_channel_key_version_key" ON "marketing"."OutreachTemplate"("tenantId", "channel", "key", "version");

-- CreateIndex
CREATE INDEX "OutreachTemplate_tenantId_channel_isActive_idx" ON "marketing"."OutreachTemplate"("tenantId", "channel", "isActive");
