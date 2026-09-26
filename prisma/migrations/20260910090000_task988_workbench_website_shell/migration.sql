-- The customer's own page furniture, captured for the Workbench.
--
-- Nullable, and null is meaningful: a demo built before this existed simply has
-- no shell, and the interface says so rather than inventing one.
ALTER TABLE "marketing"."WorkbenchDemo" ADD COLUMN "websiteShell" JSONB;
