-- TASK #983 — a missing foreign key found while building engagement tracking.
--
-- OutreachCampaign.auditRunId had no relation, exactly as
-- WorkbenchDemo.auditRunId did before Task #982. Deleting an audit run left the
-- campaign and its actions behind: 6 orphaned campaigns and 30 orphaned actions
-- were present, each citing an approved audit that no longer existed. An
-- engagement timeline built from those actions would quote evidence nobody
-- could open. The orphans were deleted before this constraint was added.
--
-- NOTE ON THE pgvector INDEXES
-- `prisma migrate diff` emits DROP INDEX for knowledge_chunk_embedding_hnsw and
-- knowledge_chunk_tsv_gin on every migration, because Prisma cannot model an
-- HNSW or a GIN index and therefore believes they are drift. They are not.
-- Both DROP statements are stripped here, as in every prior migration, and the
-- indexes are verified present afterwards.

-- AddForeignKey
ALTER TABLE "OutreachCampaign" ADD CONSTRAINT "OutreachCampaign_auditRunId_fkey" FOREIGN KEY ("auditRunId") REFERENCES "WebsiteAuditRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

