import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Ban, CheckCircle2 } from 'lucide-react'
import { ENGINE_BY_ID, PIPELINE, engineAccent, type EngineDef } from '../../lib/engines'
import { useTheme } from '../../lib/theme'
import { AgentMark, type AgentState } from '../agent/AgentMark'
import './shell.css'
import './engine.css'

// ─────────────────────────────────────────────────────────────────────────
// The engine workspace frame.
//
// Every engine opens the same way: what it is, what it does, what state it is
// in, and where it sits in the pipeline. The header is where an operator
// confirms they are in the right place, and where an engineer sees which
// engine they are looking at when something has gone wrong.
// ─────────────────────────────────────────────────────────────────────────

/**
 * What the footer says about where this engine got to.
 *
 * The "Next in the pipeline" link was there before, but it said the same thing
 * whether the run had finished, was still queued behind a worker that was not
 * running, or could never finish for this company. A person reading the screen
 * had to work out "am I done here?" from the counters — and for a queued run
 * those counters were zeros. The screen tells the footer instead.
 */
export interface EngineCompletion {
  /** True once this engine has finished for the company on screen. */
  done: boolean
  /**
   * The completion sentence, when "<engine> complete" is not the whole truth —
   * an audit that completed over a one-page site with no product page is
   * complete, and must say so, without implying a report can be built from it.
   */
  label?: string
  /**
   * Why this engine cannot finish here. When set, the footer keeps the plain
   * next link and names the block; it never claims completion, whatever `done`
   * says, because a blocked engine drawn as finished is exactly the lie the
   * footer exists to stop.
   */
  blockedReason?: string
  /**
   * Where "next" goes, when the caller has a reason to pin it. Left unset, the
   * link is the next engine's bare path: the run key is per company, so the
   * next screen restores its own lineage on arrival and a run param here would
   * only override it.
   */
  nextTo?: string
}

export function EnginePage({
  engineId,
  state = 'idle',
  actions,
  children,
  signature,
  completion,
}: {
  engineId: string
  /** Drives the agent mark in the header. */
  state?: AgentState
  actions?: ReactNode
  children: ReactNode
  /** The engine's signature motion, shown as a header band. */
  signature?: ReactNode
  /** Turns the footer into a completion callout, or a blocked notice. */
  completion?: EngineCompletion
}) {
  const { theme } = useTheme()
  const engine = ENGINE_BY_ID.get(engineId)
  if (!engine) return <>{children}</>

  const Icon = engine.icon
  const nextTo = completion?.nextTo ?? PIPELINE.find((e) => e.stage === engine.stage + 1)?.path
  // The engine the link names. Normally the next stage; when `nextTo` pins
  // another engine's path — the Audit Report, once its report is approved,
  // sends the reader past Human Approval to the AI Workbench — the link takes
  // THAT engine's title and accent. A link reading "Human Approval" that opens
  // the Workbench would be the footer lying about where it goes.
  const next =
    (completion?.nextTo ? PIPELINE.find((e) => e.path === completion.nextTo) : undefined) ??
    PIPELINE.find((e) => e.stage === engine.stage + 1)
  const nextAccent = next ? engineAccent(next, theme) : undefined

  // Blocked wins over done: both can arrive when a screen derives them from
  // separate facts, and of the two only "blocked" is safe to overstate.
  const blocked = completion?.blockedReason
  const done = !blocked && completion?.done === true

  return (
    <div className="engine">
      <header className="engine__head">
        {signature && <div className="engine__signature" aria-hidden="true">{signature}</div>}

        <div className="engine__headrow">
          <div className="engine__identity">
            <span className="engine__icon" style={{ ['--e' as string]: engine.accent }}>
              <Icon size={19} aria-hidden="true" />
            </span>
            <div className="engine__titles">
              <div className="engine__titleline">
                <h1 className="engine__title">{engine.title}</h1>
                {PIPELINE.includes(engine) && (
                  <span className="engine__stage mono">Stage {engine.stage} of {PIPELINE.length}</span>
                )}
              </div>
              <p className="engine__purpose">{engine.purpose}</p>
            </div>
          </div>

          <div className="engine__headright">
            <AgentMark state={state} size={22} />
            {actions}
          </div>
        </div>
      </header>

      {/* ABOVE the content, not below it.
          It sat under the body, which is fine on a short screen and useless on
          a long one: the Audit Report renders six PDF pages and the Workbench a
          whole product page, so "go to the next engine" was a scroll to the
          bottom of a very tall page. The one control that moves an operator
          through the pipeline should not be the hardest thing to reach. */}
      {done ? (
        // The callout is tinted in the engine that completed; the link keeps
        // the next engine's accent, as the plain footer always has.
        <footer
          className="engine__next engine__next--done"
          role="status"
          style={{ ['--e' as string]: engineAccent(engine, theme) }}
        >
          <span className="engine__done">
            <CheckCircle2 size={16} aria-hidden="true" />
            {completion?.label ?? `${engine.title} complete`}
          </span>
          {next && nextTo ? (
            <Link to={nextTo} className="engine__nextlink engine__nextlink--cta" style={{ ['--e' as string]: nextAccent }}>
              <span className="eyebrow engine__nextlabel">Next</span>
              {next.title}
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          ) : (
            <span className="eyebrow">End of the pipeline</span>
          )}
        </footer>
      ) : blocked ? (
        // A blocked engine still shows where the pipeline goes: the person
        // may have to carry on without this stage, and should not have to
        // guess the route. What it never shows is a tick.
        <footer className="engine__next engine__next--blocked">
          {next && nextTo && (
            <>
              <span className="eyebrow">Next in the pipeline</span>
              <Link to={nextTo} className="engine__nextlink" style={{ ['--e' as string]: nextAccent }}>
                {next.title}
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </>
          )}
          <p className="engine__nextreason">
            <Ban size={14} aria-hidden="true" />
            {blocked}
          </p>
        </footer>
      ) : (
        next && (
          <footer className="engine__next">
            <span className="eyebrow">Next in the pipeline</span>
            <Link to={nextTo ?? next.path} className="engine__nextlink" style={{ ['--e' as string]: nextAccent }}>
              {next.title}
              <ArrowRight size={13} aria-hidden="true" />
            </Link>
          </footer>
        )
      )}

      <div className="engine__body">{children}</div>
    </div>
  )
}

/** A two-column workspace: main work on the left, supporting detail right. */
export function EngineSplit({
  main,
  side,
  sideWidth = 320,
}: {
  main: ReactNode
  side: ReactNode
  sideWidth?: number
}) {
  return (
    <div className="engine__split" style={{ ['--side' as string]: `${sideWidth}px` }}>
      <div className="engine__main">{main}</div>
      <div className="engine__side">{side}</div>
    </div>
  )
}

export function useEngine(id: string): EngineDef {
  const { theme } = useTheme()
  const engine = ENGINE_BY_ID.get(id)
  if (!engine) throw new Error(`Unknown engine "${id}"`)
  // `accent` is resolved here so every workspace keeps reading one field and
  // still draws in the value its theme can carry.
  return useMemo(() => ({ ...engine, accent: engineAccent(engine, theme) }), [engine, theme])
}
