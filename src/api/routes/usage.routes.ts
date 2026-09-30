import { Router } from 'express'
import { env } from '../../config/env.js'
import { prisma } from '../../platform/db.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requirePermission } from '../middleware/rbac.js'

// MARKETING AI PROJECT USAGE — WHAT THIS APPLICATION SPENT.
//
// Every figure here comes from this application's own LlmCall table, one row
// per request, with token counts taken from the provider's own usage metadata
// and never estimated. Where the provider answered without returning counts
// the row is still recorded and its tokens stay zero, flagged by
// `hasUsageData` — so "we made 40 calls and can only account for 31 of them"
// is sayable, and is said, rather than being quietly rounded into a total.
//
// THE SCOPE IS STRUCTURAL, NOT A FILTER.
//
// LlmCall has exactly one writer — recordLlmCall() in src/llm/tokenLedger.ts —
// and that is called from exactly one place, this application's own Gemini
// gateway. A row therefore cannot exist unless THIS application made the
// request that produced it. Another project sharing the same API key, a script
// run from a laptop, a different service in the same account: none of them can
// write here, so none of them can appear here. That is a much stronger promise
// than a WHERE clause, and it is why this endpoint does not need one.
//
// The corollary is the thing the page must say out loud: this is NOT a Google
// billing figure and it is not the key's total consumption. It is one
// application's own ledger. Presenting it as an account balance would be a
// fabrication of a particularly bad kind — every number would be real, and the
// thing they claimed to measure would not be.

export const usageRoutes = Router()

/** Whole days, so a window means the same thing to everyone reading it. */
const startOfDayUtc = (d: Date): Date => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))

usageRoutes.get(
  '/gemini',
  // 2026-09-30: what the platform has spent is an admin's business, not
  // everyone's. Ordinary users run the engines; the bill is not theirs to see.
  requirePermission('admin'),
  asyncHandler(async (req, res) => {
    const p = req.principal!
    const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365)

    const to = new Date()
    const from = startOfDayUtc(new Date(to.getTime() - (days - 1) * 86_400_000))

    // Whether the platform is configured to call Gemini at all. A dashboard
    // showing zero because nothing is configured and a dashboard showing zero
    // because nothing was used are different answers to the same question.
    const configured = env.GEMINI_API_KEY.trim().length > 0 && env.LLM_DRIVER === 'real'
    const configurationNote = !configured
      ? env.LLM_DRIVER !== 'real'
        ? `LLM_DRIVER is "${env.LLM_DRIVER}", so no request has been sent to Gemini from this environment.`
        : 'GEMINI_API_KEY is not set in this environment, so no request has been sent to Gemini.'
      : null

    const calls = await prisma.llmCall.findMany({
      where: { tenantId: p.tenantId, provider: 'gemini', createdAt: { gte: from } },
      select: {
        feature: true,
        model: true,
        modelRequested: true,
        fellBack: true,
        promptTokens: true,
        outputTokens: true,
        totalTokens: true,
        hasUsageData: true,
        costUsd: true,
        priced: true,
        latencyMs: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20_000,
    })

    if (calls.length === 0) {
      return res.json({
        provider: 'gemini',
        // Names what is being reported on, so the figure is never read as the
        // key's global consumption.
        scope: 'marketing_ai_project',
        scopeLabel: 'Marketing AI project usage',
        configured,
        available: false,
        // The exact wording the interface shows. Distinguishing "unavailable"
        // from "zero" is the whole point of this branch.
        unavailableReason:
          configurationNote ??
          `No Gemini request has been recorded for this tenant in the last ${days} day(s).`,
        window: { from: from.toISOString(), to: to.toISOString(), days },
        note: SOURCE_NOTE,
        scopeNote: SCOPE_NOTE,
      })
    }

    const sum = <K extends 'promptTokens' | 'outputTokens' | 'totalTokens'>(k: K): number =>
      calls.reduce((n, c) => n + c[k], 0)

    const priced = calls.filter((c) => c.priced)
    const costUsd = priced.reduce((n, c) => n + Number(c.costUsd), 0)
    const withoutUsage = calls.filter((c) => !c.hasUsageData).length

    const group = <T extends string>(key: (c: (typeof calls)[number]) => T) => {
      const m = new Map<T, { key: T; calls: number; totalTokens: number; costUsd: number }>()
      for (const c of calls) {
        const k = key(c)
        const row = m.get(k) ?? { key: k, calls: 0, totalTokens: 0, costUsd: 0 }
        row.calls += 1
        row.totalTokens += c.totalTokens
        if (c.priced) row.costUsd += Number(c.costUsd)
        m.set(k, row)
      }
      return [...m.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls)
    }

    // One row per day in the window, including the days with nothing on them:
    // a chart that silently omits quiet days reads as continuous activity.
    const daily: Array<{ date: string; calls: number; totalTokens: number }> = []
    for (let i = 0; i < days; i++) {
      const day = new Date(from.getTime() + i * 86_400_000)
      const next = new Date(day.getTime() + 86_400_000)
      const inDay = calls.filter((c) => c.createdAt >= day && c.createdAt < next)
      daily.push({
        date: day.toISOString().slice(0, 10),
        calls: inDay.length,
        totalTokens: inDay.reduce((n, c) => n + c.totalTokens, 0),
      })
    }

    const latencies = calls.map((c) => c.latencyMs).sort((a, b) => a - b)

    res.json({
      provider: 'gemini',
      scope: 'marketing_ai_project',
      scopeLabel: 'Marketing AI project usage',
      configured,
      available: true,
      window: { from: from.toISOString(), to: to.toISOString(), days },
      totals: {
        calls: calls.length,
        promptTokens: sum('promptTokens'),
        outputTokens: sum('outputTokens'),
        totalTokens: sum('totalTokens'),
        // Only over the calls that were actually priced. Summing unpriced
        // rows as zero would present an incomplete cost as a total one.
        costUsd: Number(costUsd.toFixed(6)),
        pricedCalls: priced.length,
        unpricedCalls: calls.length - priced.length,
        callsWithoutUsageData: withoutUsage,
        fellBack: calls.filter((c) => c.fellBack).length,
        medianLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : 0,
      },
      byFeature: group((c) => c.feature),
      byModel: group((c) => c.model),
      daily,
      caveats: [
        withoutUsage > 0
          ? `${withoutUsage} of ${calls.length} call(s) returned no token counts from the provider. They are counted as calls and contribute zero tokens.`
          : null,
        calls.length - priced.length > 0
          ? `${calls.length - priced.length} call(s) have no price recorded, so the cost figure covers ${priced.length} call(s) only.`
          : null,
      ].filter((x): x is string => x !== null),
      note: SOURCE_NOTE,
      scopeNote: SCOPE_NOTE,
    })
  }),
)

/** The wording the dashboard shows, verbatim. Approved copy — do not paraphrase. */
const SOURCE_NOTE =
  'This dashboard reports Gemini usage recorded by this application only. Usage generated by other projects or ' +
  'applications using the same API key is not included.'

/**
 * Why that claim holds, for a reader who wants more than an assurance.
 *
 * Separate from the note so the interface can show the promise first and the
 * mechanism second, rather than making every reader work through both.
 */
const SCOPE_NOTE =
  'Counted from this application’s own request ledger, one row per request, using the token counts the provider ' +
  'returned. Rows are written by this application’s Gemini gateway and by nothing else, so a request made by ' +
  'another project cannot appear here. It is not a Google billing figure and not the API key’s total consumption.'
