-- Run ONCE, as a superuser, BEFORE the first `prisma migrate`.
-- The vector type must exist before Prisma can create a vector(768) column.

CREATE SCHEMA IF NOT EXISTS marketing;

-- The extension is installed INTO the marketing schema, not into public.
--
-- MARKETING_DATABASE_URL carries ?schema=marketing, so Prisma connects with
-- search_path set to `marketing` alone. An extension sitting in `public` is
-- then invisible: the migration fails with `type "vector" does not exist` even
-- though the extension is plainly installed. Putting the type in the same
-- schema as the table that uses it keeps both the Prisma migration and the raw
-- SQL in knowledge/vectorStore.ts resolving without a search_path override.
CREATE EXTENSION IF NOT EXISTS vector SCHEMA marketing;
