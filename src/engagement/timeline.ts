import { prisma } from '../platform/db.js'
import { freshness } from './normalize.js'
import { EVENT_ACTOR } from './types.js'
import type {
  EngagementChannel,
  EngagementEventType,
  EventActor,
  EventEvidence,
  FreshnessLabel,
} from './types.js'

// TASK #983 — reading the history back.
//
// Everything below is a COUNT, a TIMESTAMP or a LIST. There is no weighting, no
// total, no rank and no derived level. `emailOpened: 3` is a fact; turning it
// into "warm" is a decision this stage does not make and deliberately does not
// leave a field for.
//
// The distinction matters most in the summary. A summary is where a score
// wants to appear — one number to sort a list by — so this one returns the
// components and refuses to combine them.

export interface TimelineEntry {
  id: string
  eventType: EngagementEventType
  /**
   * Who performed the act, from the canonical EVENT_ACTOR map.
   *
   * Published per entry so a caller never has to infer it. The summary carries
   * the same classification as totals; this is the same rule applied one event
   * at a time, from the same table, so the two cannot disagree.
   */
  actor: EventActor
  channel: EngagementChannel
  source: string
  sourceProvider: string | null
  occurredAt: Date
  receivedAt: Date
  /** Age at the time of reading, not at the time of recording. */
  freshnessLabel: FreshnessLabel
  ageHours: number
  /** Set when a claimed timestamp was corrected on the way in. */
  timestampNote: string | null
  sessionRef: string | null
  workbenchDemoId: string | null
  outreachActionId: string | null
  auditRunId: string | null
  evidence: EventEvidence
  metadata: Record<string, unknown>
}

export interface TimelineQuery {
  tenantId: string
  crmCompanyId: string
  channel?: EngagementChannel
  eventType?: EngagementEventType
  since?: Date
  until?: Date
  limit?: number
  cursor?: string
}

export interface TimelinePage {
  entries: TimelineEntry[]
  nextCursor: string | null
  hasMore: boolean
}

/**
 * The canonical actor for an event type.
 *
 * An unmapped type falls back to `prospect`, which is the conservative
 * reading: treating our own act as the prospect's would overstate engagement,
 * so the map is exhaustive by construction and this is only a type guard.
 */
export function actorOf(eventType: string): EventActor {
  return EVENT_ACTOR[eventType as EngagementEventType] ?? 'prospect'
}

function toEntry(row: {
  id: string
  eventType: string
  channel: string
  source: string
  sourceProvider: string | null
  occurredAt: Date
  receivedAt: Date
  timestampNote: string | null
  sessionRef: string | null
  workbenchDemoId: string | null
  outreachActionId: string | null
  auditRunId: string | null
  evidence: unknown
  metadata: unknown
}, now: Date): TimelineEntry {
  // Freshness is recomputed at read time. The stored label was true when the
  // row was written; a timeline opened three weeks later should not still be
  // calling that event "fresh".
  const { label, ageHours } = freshness(row.occurredAt, now)
  return {
    id: row.id,
    eventType: row.eventType as EngagementEventType,
    actor: actorOf(row.eventType),
    channel: row.channel as EngagementChannel,
    source: row.source,
    sourceProvider: row.sourceProvider,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
    freshnessLabel: label,
    ageHours,
    timestampNote: row.timestampNote,
    sessionRef: row.sessionRef,
    workbenchDemoId: row.workbenchDemoId,
    outreachActionId: row.outreachActionId,
    auditRunId: row.auditRunId,
    evidence: (row.evidence ?? { what: '', where: null, how: '', referenceKind: null, referenceId: null }) as EventEvidence,
    metadata: (row.metadata ?? {}) as Record<string, unknown>,
  }
}

/**
 * One company's history, newest act first.
 *
 * Ordered by `occurredAt`, not `receivedAt`: a webhook that arrives late still
 * belongs where the act happened. Ties break on id so the cursor is stable.
 */
export async function companyTimeline(query: TimelineQuery, now = new Date()): Promise<TimelinePage> {
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200)

  const where: Record<string, unknown> = {
    tenantId: query.tenantId,
    crmCompanyId: query.crmCompanyId,
  }
  if (query.channel) where.channel = query.channel
  if (query.eventType) where.eventType = query.eventType
  if (query.since || query.until) {
    where.occurredAt = {
      ...(query.since ? { gte: query.since } : {}),
      ...(query.until ? { lte: query.until } : {}),
    }
  }

  const rows = await prisma.engagementEvent.findMany({
    where,
    orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
  })

  const hasMore = rows.length > limit
  const page = hasMore ? rows.slice(0, limit) : rows

  return {
    entries: page.map((r) => toEntry(r, now)),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
    hasMore,
  }
}

/** The same history, scoped to one Workbench demo. */
export async function demoTimeline(
  tenantId: string,
  workbenchDemoId: string,
  now = new Date(),
): Promise<TimelineEntry[]> {
  const rows = await prisma.engagementEvent.findMany({
    where: { tenantId, workbenchDemoId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    take: 500,
  })
  return rows.map((r) => toEntry(r, now))
}

/**
 * Counts. Not a score.
 *
 * Every field below is either a tally of observed acts or a timestamp. Nothing
 * is added, weighted or normalised across categories, because the moment two
 * different acts get combined into one number, that number is an opinion about
 * interest — which is the next stage's job, not this one's.
 */
export interface EngagementSummary {
  crmCompanyId: string
  totalEvents: number
  /**
   * Split by who performed the act, from EVENT_ACTOR.
   *
   * `systemEvents` covers facts produced by the plumbing rather than by either
   * party — a bounce, a provider delivery confirmation. They are counted apart
   * so that a wrong email address is never read as a statement by the prospect.
   */
  prospectEvents: number
  ourEvents: number
  systemEvents: number
  byChannel: Record<string, number>
  byEventType: Record<string, number>
  bySource: Record<string, number>
  firstEventAt: Date | null
  lastEventAt: Date | null
  /** Freshness of the most recent act. A label, read at query time. */
  lastEventFreshness: FreshnessLabel
  lastEventAgeHours: number | null
  /** How many distinct visits produced events. */
  distinctSessions: number
  /** Every channel where at least one act was observed. */
  channelsObserved: string[]
  /** Channels with no observed act, stated positively rather than left out. */
  channelsNotObserved: string[]
}

const ALL_CHANNELS = ['workbench', 'audit_report', 'email', 'linkedin', 'call', 'whatsapp']

export async function engagementSummary(
  tenantId: string,
  crmCompanyId: string,
  now = new Date(),
): Promise<EngagementSummary> {
  const rows = await prisma.engagementEvent.findMany({
    where: { tenantId, crmCompanyId },
    select: {
      eventType: true,
      channel: true,
      source: true,
      occurredAt: true,
      sessionRef: true,
    },
    orderBy: { occurredAt: 'asc' },
  })

  const byChannel: Record<string, number> = {}
  const byEventType: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  const sessions = new Set<string>()
  let prospectEvents = 0
  let ourEvents = 0
  let systemEvents = 0

  for (const row of rows) {
    byChannel[row.channel] = (byChannel[row.channel] ?? 0) + 1
    byEventType[row.eventType] = (byEventType[row.eventType] ?? 0) + 1
    bySource[row.source] = (bySource[row.source] ?? 0) + 1
    if (row.sessionRef) sessions.add(row.sessionRef)

    const actor = actorOf(row.eventType)
    if (actor === 'altiusnxt') ourEvents++
    else if (actor === 'system') systemEvents++
    else prospectEvents++
  }

  const firstEventAt = rows[0]?.occurredAt ?? null
  const lastEventAt = rows[rows.length - 1]?.occurredAt ?? null
  const last = lastEventAt ? freshness(lastEventAt, now) : null

  const channelsObserved = ALL_CHANNELS.filter((c) => (byChannel[c] ?? 0) > 0)

  return {
    crmCompanyId,
    totalEvents: rows.length,
    prospectEvents,
    ourEvents,
    systemEvents,
    byChannel,
    byEventType,
    bySource,
    firstEventAt,
    lastEventAt,
    lastEventFreshness: last?.label ?? 'unknown',
    lastEventAgeHours: last?.ageHours ?? null,
    distinctSessions: sessions.size,
    channelsObserved,
    // Absence recorded positively, as everywhere else in this platform: "no act
    // was observed on LinkedIn" is a different statement from silence.
    channelsNotObserved: ALL_CHANNELS.filter((c) => !channelsObserved.includes(c)),
  }
}

export async function getEvent(tenantId: string, id: string, now = new Date()): Promise<TimelineEntry | null> {
  const row = await prisma.engagementEvent.findFirst({ where: { id, tenantId } })
  return row ? toEntry(row, now) : null
}
