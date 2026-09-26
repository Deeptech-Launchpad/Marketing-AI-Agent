-- The count an operator asked for on the search form.
--
-- Nullable, and null is meaningful: it means nothing was stated and the count
-- read out of the objective's wording still applies. Existing rows keep that
-- behaviour, so no past search changes its meaning.
ALTER TABLE "marketing"."ProspectSearch" ADD COLUMN "requestedCount" INTEGER;
