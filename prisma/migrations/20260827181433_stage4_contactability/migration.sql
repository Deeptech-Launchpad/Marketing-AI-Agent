-- Stage 4: contactability, kept separate from confidence so a HIGH-confidence
-- candidate with no email does not read as a weak one.
--
-- Hand-written rather than diffed, to avoid `prisma migrate diff` re-emitting
-- DROP INDEX for the two pgvector indexes it cannot express.
ALTER TABLE "DecisionMakerCandidate" ADD COLUMN "contactability" TEXT NOT NULL DEFAULT 'none';
