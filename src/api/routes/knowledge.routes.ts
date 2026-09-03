import { Router } from 'express'
import { z } from 'zod'
import { CORPUS_TYPES } from '../../domain/enums.js'
import { createDocument } from '../../knowledge/ingest.js'
import { retrieve } from '../../knowledge/retriever.js'
import { deleteChunksForDocument } from '../../knowledge/vectorStore.js'
import { audit } from '../../platform/audit.js'
import { prisma } from '../../platform/db.js'
import { NotFoundError } from '../../platform/errors.js'
import { enqueue, QUEUE_KNOWLEDGE_INGEST } from '../../platform/queue.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'
import { validateBody } from '../middleware/validate.js'

export const knowledgeRoutes = Router()

const CreateDocument = z.object({
  corpusType: z.enum(CORPUS_TYPES),
  title: z.string().min(1).max(300),
  // Plain text / markdown only in Phase 1. PDF and DOCX extraction waits until
  // the corpus is real and the formats are known, rather than carrying a parser
  // nobody needed.
  content: z.string().min(1),
  sourceUri: z.string().url().optional(),
  metadata: z.record(z.unknown()).optional(),
})

knowledgeRoutes.post(
  '/documents',
  requirePermission('operate'),
  validateBody(CreateDocument),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof CreateDocument>

    const { id } = await createDocument({
      tenantId: p.tenantId,
      corpusType: body.corpusType,
      title: body.title,
      content: body.content,
      sourceUri: body.sourceUri ?? null,
      uploadedByCrmUserId: p.crmUserId,
      metadata: body.metadata ?? null,
    })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'knowledge.uploaded',
      resourceType: 'KnowledgeDocument',
      resourceId: id,
      summary: `${body.corpusType}: ${body.title}`,
      requestId: req.requestId,
    })

    // 202: chunking and embedding happen in the worker, not in this request.
    res.status(202).json({ id, status: 'pending' })
  }),
)

knowledgeRoutes.get(
  '/documents',
  requirePermission('view'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const corpusType = typeof req.query.corpusType === 'string' ? req.query.corpusType : undefined

    const documents = await prisma.knowledgeDocument.findMany({
      where: { tenantId: p.tenantId, ...(corpusType ? { corpusType } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: {
        id: true,
        corpusType: true,
        title: true,
        status: true,
        chunkCount: true,
        sizeChars: true,
        error: true,
        createdAt: true,
      },
    })

    // Which corpora are actually populated is worth knowing at a glance: an
    // empty brand_guidelines corpus means content validation has no rules to
    // check against, and the run output says so.
    const coverage = Object.fromEntries(
      CORPUS_TYPES.map((c) => [c, documents.filter((d) => d.corpusType === c && d.status === 'ready').length]),
    )

    res.json({ documents, coverage })
  }),
)

knowledgeRoutes.delete(
  '/documents/:id',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true, title: true },
    })
    if (!doc) throw new NotFoundError('Document not found.')

    await deleteChunksForDocument(doc.id)
    await prisma.knowledgeDocument.delete({ where: { id: doc.id } })

    await audit({
      tenantId: p.tenantId,
      actorType: 'user',
      actorCrmUserId: p.crmUserId,
      action: 'knowledge.deleted',
      resourceType: 'KnowledgeDocument',
      resourceId: doc.id,
      summary: doc.title,
      requestId: req.requestId,
    })
    res.json({ id: doc.id, deleted: true })
  }),
)

knowledgeRoutes.post(
  '/documents/:id/reindex',
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const doc = await prisma.knowledgeDocument.findFirst({
      where: { id: req.params.id, tenantId: p.tenantId },
      select: { id: true },
    })
    if (!doc) throw new NotFoundError('Document not found.')

    await prisma.knowledgeDocument.update({ where: { id: doc.id }, data: { status: 'pending' } })
    await enqueue(QUEUE_KNOWLEDGE_INGEST, { documentId: doc.id })
    res.status(202).json({ id: doc.id, status: 'pending' })
  }),
)

const SearchBody = z.object({
  query: z.string().min(1).max(1000),
  corpusTypes: z.array(z.enum(CORPUS_TYPES)).optional(),
  topN: z.number().int().positive().max(20).optional(),
})

/** Inspection endpoint — shows exactly what retrieval would feed to a prompt. */
knowledgeRoutes.post(
  '/search',
  requirePermission('view'),
  validateBody(SearchBody),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const body = req.body as z.infer<typeof SearchBody>

    const chunks = await retrieve({
      tenantId: p.tenantId,
      query: body.query,
      corpusTypes: body.corpusTypes,
      topN: body.topN,
    })
    res.json({ chunks })
  }),
)
