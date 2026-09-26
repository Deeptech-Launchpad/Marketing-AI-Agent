-- How a seller could OPEN a conversation on this signal, in one sentence.
--
-- Nullable, and null is meaningful: it means this signal suggests no
-- particular approach, and a signal with no angle must be shown without one
-- rather than given an invented one. An angle is a suggestion about OUR
-- wording; it is never a claim about the company, so it can always be absent.
--
-- Every existing row keeps null and therefore keeps its current meaning.
ALTER TABLE "marketing"."IntentSignal" ADD COLUMN "outreachAngle" TEXT;
