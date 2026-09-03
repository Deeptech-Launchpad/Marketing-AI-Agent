import { Prisma } from '@prisma/client'
import { prisma, newId } from '../platform/db.js'

// Raw SQL layer for the two Postgres-native columns Prisma cannot handle:
// KnowledgeChunk.embedding (vector) and .tsv (tsvector).
//
// Every statement here is parameterised. The only interpolated value is the
// vector literal, which is built from numbers that have already been validated
// as finite — never from free text.

export interface ChunkInsert {
  tenantId: string
  documentId: string
  seq: number
  content: string
  tokenCount: number
  sectionPath: string | null
  embedding: number[]
  embeddingModel: string
}

export interface ChunkHit {
  id: string
  documentId: string
  seq: number
  content: string
  sectionPath: string | null
  score: number
}

/** vector literal: '[0.1,0.2,...]'. Rejects non-finite values outright. */
function vectorLiteral(values: number[]): string {
  for (const v of values) {
    if (!Number.isFinite(v)) throw new Error('Embedding contains a non-finite value.')
  }
  return `[${values.join(',')}]`
}

export async function insertChunks(rows: ChunkInsert[]): Promise<number> {
  let written = 0
  for (const r of rows) {
    await prisma.$executeRaw`
      INSERT INTO marketing."KnowledgeChunk"
        ("id", "tenantId", "documentId", "seq", "content", "tokenCount",
         "sectionPath", "embeddingModel", "embedding", "tsv", "createdAt")
      VALUES
        (${newId()}, ${r.tenantId}, ${r.documentId}, ${r.seq}, ${r.content}, ${r.tokenCount},
         ${r.sectionPath}, ${r.embeddingModel}, ${vectorLiteral(r.embedding)}::vector,
         to_tsvector('english', ${r.content}), now())
      ON CONFLICT ("documentId", "seq") DO NOTHING
    `
    written++
  }
  return written
}

/** Cosine distance; score is 1 - distance so higher is always better. */
export async function searchByVector(params: {
  tenantId: string
  embedding: number[]
  corpusTypes?: string[]
  limit: number
}): Promise<ChunkHit[]> {
  const corpusFilter =
    params.corpusTypes?.length
      ? Prisma.sql`AND d."corpusType" = ANY(${params.corpusTypes})`
      : Prisma.empty

  return prisma.$queryRaw<ChunkHit[]>`
    SELECT c."id", c."documentId", c."seq", c."content", c."sectionPath",
           1 - (c."embedding" <=> ${vectorLiteral(params.embedding)}::vector) AS score
    FROM marketing."KnowledgeChunk" c
    JOIN marketing."KnowledgeDocument" d ON d."id" = c."documentId"
    WHERE c."tenantId" = ${params.tenantId}
      AND c."embedding" IS NOT NULL
      AND d."status" = 'ready'
      ${corpusFilter}
    ORDER BY c."embedding" <=> ${vectorLiteral(params.embedding)}::vector
    LIMIT ${params.limit}
  `
}

/** Keyword half of hybrid retrieval — catches exact terms embeddings miss. */
export async function searchByKeyword(params: {
  tenantId: string
  query: string
  corpusTypes?: string[]
  limit: number
}): Promise<ChunkHit[]> {
  const corpusFilter =
    params.corpusTypes?.length
      ? Prisma.sql`AND d."corpusType" = ANY(${params.corpusTypes})`
      : Prisma.empty

  return prisma.$queryRaw<ChunkHit[]>`
    SELECT c."id", c."documentId", c."seq", c."content", c."sectionPath",
           ts_rank(c."tsv", plainto_tsquery('english', ${params.query})) AS score
    FROM marketing."KnowledgeChunk" c
    JOIN marketing."KnowledgeDocument" d ON d."id" = c."documentId"
    WHERE c."tenantId" = ${params.tenantId}
      AND d."status" = 'ready'
      AND c."tsv" @@ plainto_tsquery('english', ${params.query})
      ${corpusFilter}
    ORDER BY score DESC
    LIMIT ${params.limit}
  `
}

export async function deleteChunksForDocument(documentId: string): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM marketing."KnowledgeChunk" WHERE "documentId" = ${documentId}
  `
}
