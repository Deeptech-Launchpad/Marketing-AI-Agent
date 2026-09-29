-- Per-user mailbox sending was not approved (2026-09-29): outreach is sent
-- manually from each user's own mail program. Remove the unused table and
-- column added by the previous migration.
DROP TABLE IF EXISTS "UserMailbox";
ALTER TABLE "OutreachSendAttempt" DROP COLUMN IF EXISTS "fromAddress";
