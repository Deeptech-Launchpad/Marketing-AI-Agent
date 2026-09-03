-- Stage 1: prospect discovery. Purely additive.
--
-- NOTE FOR FUTURE MIGRATIONS: `prisma migrate diff` also emitted
--
--   DROP INDEX "knowledge_chunk_embedding_hnsw";
--   DROP INDEX "knowledge_chunk_tsv_gin";
--
-- Those two drops have been REMOVED deliberately. The indexes are created by
-- sql/002_indexes.sql because HNSW and GIN over the Unsupported vector/tsvector
-- columns cannot be expressed in schema.prisma. Prisma therefore does not know
-- they should exist and reads them as drift on every diff.
--
-- Applying the drops would not fail and would not lose data — retrieval would
-- silently fall back to sequential scans over every chunk. Strip these two
-- lines from every future generated migration, or re-run sql/002_indexes.sql
-- afterwards.

-- CreateTable
CREATE TABLE "ProspectSearch" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "requestedByCrmUserId" TEXT NOT NULL,
    "parsed" JSONB,
    "conceptMapping" JSONB,
    "queryUsed" JSONB,
    "segmentId" TEXT,
    "snapshotId" TEXT,
    "totalMatched" INTEGER NOT NULL DEFAULT 0,
    "totalSuppressed" INTEGER NOT NULL DEFAULT 0,
    "totalReturned" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "mappingStatus" TEXT,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "provenance" JSONB,
    "error" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProspectSearch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProspectSearch_tenantId_status_idx" ON "ProspectSearch"("tenantId", "status");

-- CreateIndex
CREATE INDEX "ProspectSearch_tenantId_createdAt_idx" ON "ProspectSearch"("tenantId", "createdAt");
