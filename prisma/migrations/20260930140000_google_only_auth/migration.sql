-- Google becomes the only way in, and every account starts fresh (2026-09-30).
--
-- Deliberately destructive, as asked: the previous sign-in setup and its users
-- are removed rather than migrated. Nothing else in the platform is touched —
-- companies, signals, decision makers, drafts and audit history are untouched.

-- 1. The password system is gone: no passwords, so no reset links either.
DROP TABLE IF EXISTS "PasswordResetToken";
ALTER TABLE "AppUser" DROP COLUMN IF EXISTS "passwordHash";

-- 2. What Google tells us about the person who signed in.
ALTER TABLE "AppUser" ADD COLUMN IF NOT EXISTS "givenName" TEXT;
ALTER TABLE "AppUser" ADD COLUMN IF NOT EXISTS "familyName" TEXT;
ALTER TABLE "AppUser" ADD COLUMN IF NOT EXISTS "pictureUrl" TEXT;
ALTER TABLE "AppUser" ADD COLUMN IF NOT EXISTS "locale" TEXT;
ALTER TABLE "AppUser" ADD COLUMN IF NOT EXISTS "signInCount" INTEGER NOT NULL DEFAULT 0;

-- 3. Start fresh: no account and no role is carried over. Everyone signs in
--    with Google again, and their role is decided from the admin list.
DELETE FROM "AppUser";
DELETE FROM "TenantMember";

-- 4. Google's id is now the identity, and is required.
ALTER TABLE "AppUser" ALTER COLUMN "googleSub" SET NOT NULL;
ALTER TABLE "AppUser" ALTER COLUMN "emailVerified" SET DEFAULT true;
DROP INDEX IF EXISTS "AppUser_googleSub_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "AppUser_tenantId_googleSub_key" ON "AppUser"("tenantId", "googleSub");
