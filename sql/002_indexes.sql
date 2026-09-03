-- Run AFTER `prisma migrate deploy`. Prisma creates the vector/tsvector columns
-- (declared Unsupported in schema.prisma) but cannot express these indexes.

-- pgvector is installed INTO the marketing schema (see 001_extensions.sql), so
-- its operator classes live there too. A plain psql session connects with
-- search_path = "$user", public and cannot see them, which fails as
--   operator class "vector_cosine_ops" does not exist for access method "hnsw"
-- even though the extension is present. Setting the path here makes this file
-- runnable from any client without the caller having to know that.
SET search_path TO marketing, public;

-- Approximate nearest-neighbour index for embedding search.
CREATE INDEX IF NOT EXISTS knowledge_chunk_embedding_hnsw
  ON marketing."KnowledgeChunk"
  USING hnsw (embedding vector_cosine_ops);

-- Keyword half of hybrid retrieval.
CREATE INDEX IF NOT EXISTS knowledge_chunk_tsv_gin
  ON marketing."KnowledgeChunk"
  USING gin (tsv);
