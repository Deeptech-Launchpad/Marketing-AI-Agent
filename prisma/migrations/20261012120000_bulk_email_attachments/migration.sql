-- Bulk Email attachments (2026-10-12): files uploaded once and sent with every
-- email of a send. Additive: one new table and one new column with a default;
-- no existing row or column changes.
-- AlterTable
ALTER TABLE "BulkEmailCampaign" ADD COLUMN     "attachmentCount" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "BulkAttachment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "campaignId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "createdByCrmUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BulkAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BulkAttachment_tenantId_campaignId_idx" ON "BulkAttachment"("tenantId", "campaignId");

-- CreateIndex
CREATE INDEX "BulkAttachment_campaignId_idx" ON "BulkAttachment"("campaignId");

-- AddForeignKey
ALTER TABLE "BulkAttachment" ADD CONSTRAINT "BulkAttachment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "BulkEmailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

