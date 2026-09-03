-- Task #980: human-in-the-loop approval workflow.
--
-- NOTE: `prisma migrate diff` emitted DROP INDEX for knowledge_chunk_embedding_hnsw
-- and knowledge_chunk_tsv_gin and they have been REMOVED by hand, as in every
-- previous migration (7th occurrence). Prisma cannot express an HNSW or a
-- GIN-on-tsvector index, so it reads both as drift and proposes deleting them.
-- Applying that would silently turn every knowledge retrieval into a sequential
-- scan. Verify after applying:
--   SELECT indexname FROM pg_indexes WHERE tablename = 'KnowledgeChunk';

-- AlterTable
ALTER TABLE "AuditReport" ADD COLUMN     "approvalValidation" JSONB,
ADD COLUMN     "approvedRevision" INTEGER,
ADD COLUMN     "currentRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "decisionComment" TEXT,
ADD COLUMN     "lockVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewerCrmUserId" TEXT,
ADD COLUMN     "reviewerEmail" TEXT;

-- CreateTable
CREATE TABLE "AuditReportRevision" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditReportId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "content" JSONB NOT NULL,
    "pdfBytes" BYTEA,
    "pdfSha256" TEXT,
    "pdfPageCount" INTEGER,
    "pdfBytesSize" INTEGER,
    "createdByCrmUserId" TEXT,
    "createdByEmail" TEXT,
    "changeReason" TEXT,
    "sourceRevisionNumber" INTEGER,
    "validation" JSONB,
    "validationOk" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditReportRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditApprovalEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "auditReportId" TEXT NOT NULL,
    "auditRunId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reviewerCrmUserId" TEXT NOT NULL,
    "reviewerEmail" TEXT,
    "reviewerName" TEXT,
    "comment" TEXT,
    "validation" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditApprovalEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditReportRevision_tenantId_auditRunId_revisionNumber_idx" ON "AuditReportRevision"("tenantId", "auditRunId", "revisionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "AuditReportRevision_auditReportId_revisionNumber_key" ON "AuditReportRevision"("auditReportId", "revisionNumber");

-- CreateIndex
CREATE INDEX "AuditApprovalEvent_auditReportId_createdAt_idx" ON "AuditApprovalEvent"("auditReportId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditApprovalEvent_tenantId_auditRunId_createdAt_idx" ON "AuditApprovalEvent"("tenantId", "auditRunId", "createdAt");

-- AddForeignKey
ALTER TABLE "AuditReportRevision" ADD CONSTRAINT "AuditReportRevision_auditReportId_fkey" FOREIGN KEY ("auditReportId") REFERENCES "AuditReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditApprovalEvent" ADD CONSTRAINT "AuditApprovalEvent_auditReportId_fkey" FOREIGN KEY ("auditReportId") REFERENCES "AuditReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

