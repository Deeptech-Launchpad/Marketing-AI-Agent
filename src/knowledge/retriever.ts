import { env } from '../config/env.js'
import { prisma } from '../platform/db.js'
import { logger } from '../platform/logger.js'
import { getLlm } from '../llm/index.js'
import type { CorpusType } from '../domain/enums.js'
import { searchByKeyword, searchByVector, type ChunkHit } from './vectorStore.js'

// Hybrid retrieval with mandatory citations.
//
// Every chunk that comes back carries the document it came from, and every
// generated strategy or asset records the citation set it used. That rule is
// carried over from NXT Sales' own Customer Intelligence prompt, which requires
// each claim to be labelled with its source — it is the single best idea in the
// existing AI implementation and is worth keeping.

const VECTOR_K = 30
const KEYWORD_K = 30
const RRF_CONSTANT = 60

export interface Citation {
  documentId: string
  documentTitle: string
  corpusType: string
  sectionPath: string | null
  chunkId: string
}

export interface RetrievedChunk extends Citation {
  content: string
  score: number
}

export interface RetrieveOptions {
  tenantId: string
  query: string
  corpusTypes?: CorpusType[]
  topN?: number
  runId?: string | null
}

/**
 * Reciprocal rank fusion. Rank-based rather than score-based on purpose: the
 * cosine score and the ts_rank score are not on comparable scales, so blending
 * the raw numbers would let whichever happens to be larger dominate.
 */
function fuse(vector: ChunkHit[], keyword: ChunkHit[]): Map<string, { hit: ChunkHit; score: number }> {
  const merged = new Map<string, { hit: ChunkHit; score: number }>()

  const add = (hits: ChunkHit[]) => {
    hits.forEach((hit, index) => {
      const contribution = 1 / (RRF_CONSTANT + index + 1)
      const existing = merged.get(hit.id)
      if (existing) existing.score += contribution
      else merged.set(hit.id, { hit, score: contribution })
    })
  }

  add(vector)
  add(keyword)
  return merged
}

export async function retrieve(opts: RetrieveOptions): Promise<RetrievedChunk[]> {
  const topN = opts.topN ?? 8
  const llm = getLlm()

  const { vectors } = await llm.embed({
    texts: [opts.query],
    tenantId: opts.tenantId,
    runId: opts.runId,
  })
  const embedding = vectors[0]
  if (!embedding) return []

  const [rawVectorHits, keywordHits] = await Promise.all([
    searchByVector({
      tenantId: opts.tenantId,
      embedding,
      corpusTypes: opts.corpusTypes,
      limit: VECTOR_K,
    }),
    searchByKeyword({
      tenantId: opts.tenantId,
      query: opts.query,
      corpusTypes: opts.corpusTypes,
      limit: KEYWORD_K,
    }),
  ])

  // Relevance floor on the vector arm. Nearest-neighbour search always returns
  // SOMETHING — it ranks, it does not judge — so without this an off-topic
  // query pulls back the least-unrelated chunks in the corpus and the calling
  // step presents them to the model as though they were relevant.
  //
  // The keyword arm needs no equivalent: plainto_tsquery ANDs its terms, so an
  // unrelated query matches nothing and contributes nothing.
  const vectorHits = rawVectorHits.filter((h) => h.score >= env.KNOWLEDGE_MIN_COSINE)
  const dropped = rawVectorHits.length - vectorHits.length

  if (!vectorHits.length && !keywordHits.length) {
    logger.debug(
      { query: opts.query.slice(0, 120), dropped, bestScore: rawVectorHits[0]?.score ?? null },
      'retrieval matched nothing above the relevance floor',
    )
    return []
  }

  const ranked = [...fuse(vectorHits, keywordHits).values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)

  if (!ranked.length) return []

  // Resolve document titles in one query rather than per hit.
  const docIds = [...new Set(ranked.map((r) => r.hit.documentId))]
  const docs = await prisma.knowledgeDocument.findMany({
    where: { id: { in: docIds } },
    select: { id: true, title: true, corpusType: true },
  })
  const byId = new Map(docs.map((d) => [d.id, d]))

  return ranked.map(({ hit, score }) => {
    const doc = byId.get(hit.documentId)
    return {
      chunkId: hit.id,
      documentId: hit.documentId,
      documentTitle: doc?.title ?? 'Unknown document',
      corpusType: doc?.corpusType ?? 'unknown',
      sectionPath: hit.sectionPath,
      content: hit.content,
      score,
    }
  })
}

/**
 * Renders retrieved chunks for a prompt with explicit, quotable source labels.
 * The model is instructed elsewhere to cite these labels; making them visible
 * and stable here is what makes that instruction followable.
 */
export function formatForPrompt(chunks: RetrievedChunk[]): string {
  if (!chunks.length) return '(no knowledge base entries matched this query)'
  return chunks
    .map((c, i) => {
      const section = c.sectionPath ? ` › ${c.sectionPath}` : ''
      return `[K${i + 1}] (${c.corpusType}) ${c.documentTitle}${section}\n${c.content}`
    })
    .join('\n\n---\n\n')
}

export function toCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((c) => ({
    chunkId: c.chunkId,
    documentId: c.documentId,
    documentTitle: c.documentTitle,
    corpusType: c.corpusType,
    sectionPath: c.sectionPath,
  }))
}
