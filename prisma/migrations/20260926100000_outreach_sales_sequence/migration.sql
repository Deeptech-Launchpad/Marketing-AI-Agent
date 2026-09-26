-- The Sales-approved outreach sequence (2026-09-26).
--
-- Reuses the outreach tables so Engagement and CRM Sync keep reading them, and
-- adds only what the new flow needs: which flow a campaign runs, the stage and
-- review trail of each action, the draft/edit/attestation record of each
-- message, and the replies Sales pastes in. Every new column is nullable or
-- defaulted, so existing campaigns read exactly as before (flow = legacy).

-- AlterTable
ALTER TABLE "marketing"."OutreachCampaign" ADD COLUMN "flow" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "marketing"."OutreachCampaign" ADD COLUMN "initialVersion" TEXT;
ALTER TABLE "marketing"."OutreachCampaign" ADD COLUMN "versionSource" TEXT;
ALTER TABLE "marketing"."OutreachCampaign" ADD COLUMN "recipientEmail" TEXT;
ALTER TABLE "marketing"."OutreachCampaign" ADD COLUMN "recipientEmailSource" TEXT;

-- AlterTable
ALTER TABLE "marketing"."OutreachAction" ADD COLUMN "stageKey" TEXT;
ALTER TABLE "marketing"."OutreachAction" ADD COLUMN "dueStartAt" TIMESTAMP(3);
ALTER TABLE "marketing"."OutreachAction" ADD COLUMN "dueEndAt" TIMESTAMP(3);
ALTER TABLE "marketing"."OutreachAction" ADD COLUMN "approvedByCrmUserId" TEXT;
ALTER TABLE "marketing"."OutreachAction" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "marketing"."OutreachAction" ADD COLUMN "approvedBodyHash" TEXT;
ALTER TABLE "marketing"."OutreachAction" ADD COLUMN "sentByCrmUserId" TEXT;

-- AlterTable
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "draftSubject" TEXT;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "draftBody" TEXT;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "inputs" JSONB;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "attestations" JSONB;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "personalization" JSONB;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "revisions" JSONB;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "editedByCrmUserId" TEXT;
ALTER TABLE "marketing"."OutreachMessage" ADD COLUMN "editedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "marketing"."OutreachReply" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "text" TEXT NOT NULL,
    "modelClassification" TEXT,
    "modelEvidenceQuote" TEXT,
    "modelSkus" JSONB,
    "modelChecks" JSONB,
    "promptVersion" INTEGER,
    "classification" TEXT,
    "classificationSource" TEXT,
    "skus" JSONB,
    "confirmedByCrmUserId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "enteredByCrmUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutreachCampaign_tenantId_flow_status_idx" ON "marketing"."OutreachCampaign"("tenantId", "flow", "status");
CREATE INDEX "OutreachAction_campaignId_stageKey_idx" ON "marketing"."OutreachAction"("campaignId", "stageKey");
CREATE INDEX "OutreachReply_campaignId_receivedAt_idx" ON "marketing"."OutreachReply"("campaignId", "receivedAt");
CREATE INDEX "OutreachReply_tenantId_createdAt_idx" ON "marketing"."OutreachReply"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "marketing"."OutreachReply" ADD CONSTRAINT "OutreachReply_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "marketing"."OutreachCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
