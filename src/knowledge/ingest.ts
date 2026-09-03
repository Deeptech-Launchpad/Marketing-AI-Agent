import crypto from 'node:crypto'
import { env } from '../config/env.js'
import type { CorpusType } from '../domain/enums.js'
import { getLlm } from '../llm/index.js'
import { prisma, newId } from '../platform/db.js'
import { BadRequestError, ConflictError } from '../platform/errors.js'
import { logger } from '../platform/logger.js'
import { enqueue, QUEUE_KNOWLEDGE_INGEST } from '../platform/queue.js'
import { chunk } from './chunker.js'
import { deleteChunksForDocument, insertChunks } from './vectorStore.js'

// Ingestion runs as a queue job, never inline in the HTTP request: embedding a
// long document takes far longer than a request should be held open.
//
// Phase 1 accepts plain text and markdown only. PDF/DOCX extraction is a
// dependency decision that depends on what the corpus actually turns out to be,
// and guessing wrong means carrying a parser nobody needed.

export interface CreateDocumentInput {
  tenantId: string
  corpusType: CorpusType
  title: string
  content: string
  sourceUri?: string | null
  uploadedByCrmUserId?: string | null
  metadata?: Record<string, unknown> | null
}

function checksum(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex')
}

export async function createDocument(input: CreateDocumentInput): Promise<{ id: string }> {
  const content = input.content.trim()
  if (!content) throw new BadRequestError('Document content is empty.')
  if (content.length > env.KNOWLEDGE_MAX_UPLOAD_CHARS) {
    throw new BadRequestError(
      `Document exceeds KNOWLEDGE_MAX_UPLOAD_CHARS (${env.KNOWLEDGE_MAX_UPLOAD_CHARS}).`,
    )
  }

  const sum = checksum(content)
  const existing = await prisma.knowledgeDocument.findUnique({
    where: { tenantId_checksum: { tenantId: input.tenantId, checksum: sum } },
  })
  // Re-uploading identical content is a no-op, not a second copy: duplicate
  // chunks would both dilute retrieval and be billed twice to embed.
  if (existing) throw new ConflictError('This document has already been ingested.', { id: existing.id })

  const id = newId()
  await prisma.knowledgeDocument.create({
    data: {
      id,
      tenantId: input.tenantId,
      corpusType: input.corpusType,
      title: input.title,
      sourceType: input.sourceUri ? 'url' : 'inline',
      sourceUri: input.sourceUri ?? null,
      mimeType: 'text/plain',
      checksum: sum,
      sizeChars: content.length,
      status: 'pending',
      uploadedByCrmUserId: input.uploadedByCrmUserId ?? null,
      metadata: { ...(input.metadata ?? {}), raw: content } as never,
    },
  })

  await enqueue(QUEUE_KNOWLEDGE_INGEST, { documentId: id })
  return { id }
}

/** Queue handler. Never throws: failures are recorded on the document row. */
export async function processDocument(documentId: string): Promise<void> {
  const doc = await prisma.knowledgeDocument.findUnique({ where: { id: documentId } })
  if (!doc) return
  if (doc.status === 'ready') return

  const log = logger.child({ documentId, corpusType: doc.corpusType })

  try {
    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'processing', error: null },
    })

    const raw = (doc.metadata as { raw?: string } | null)?.raw ?? ''
    if (!raw) throw new Error('Document content was not stored.')

    const chunks = chunk(raw)
    if (!chunks.length) throw new Error('Document produced no chunks.')

    const llm = getLlm()
    const { vectors, model } = await llm.embed({
      texts: chunks.map((c) => c.content),
      tenantId: doc.tenantId,
    })
    if (vectors.length !== chunks.length) throw new Error('Embedding count did not match chunk count.')

    // Re-ingesting replaces cleanly rather than appending a second set.
    await deleteChunksForDocument(documentId)
    await insertChunks(
      chunks.map((c, i) => ({
        tenantId: doc.tenantId,
        documentId,
        seq: c.seq,
        content: c.content,
        tokenCount: c.tokenCount,
        sectionPath: c.sectionPath,
        embedding: vectors[i]!,
        embeddingModel: model,
      })),
    )

    await prisma.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'ready', chunkCount: chunks.length, error: null },
    })
    log.info({ chunks: chunks.length }, 'knowledge document ingested')
  } catch (err) {
    const message = (err as Error).message
    log.error({ err }, 'knowledge ingestion failed')
    await prisma.knowledgeDocument
      .update({ where: { id: documentId }, data: { status: 'failed', error: message } })
      .catch(() => undefined)
  }
}
