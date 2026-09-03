import { useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
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

export function EnginePage({
  engineId,
  state = 'idle',
  actions,
  children,
  signature,
}: {
  engineId: string
  /** Drives the agent mark in the header. */
  state?: AgentState
  actions?: ReactNode
  children: ReactNode
  /** The engine's signature motion, shown as a header band. */
  signature?: ReactNode
}) {
  const { theme } = useTheme()
  const engine = ENGINE_BY_ID.get(engineId)
  if (!engine) return <>{children}</>

  const Icon = engine.icon
  const next = PIPELINE.find((e) => e.stage === engine.stage + 1)

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
                <span className="engine__stage mono">Stage {engine.stage} of 12</span>
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

      <div className="engine__body">{children}</div>

      {next && (
        <footer className="engine__next">
          <span className="eyebrow">Next in the pipeline</span>
          <Link to={next.path} className="engine__nextlink" style={{ ['--e' as string]: engineAccent(next, theme) }}>
            {next.title}
            <ArrowRight size={13} aria-hidden="true" />
          </Link>
        </footer>
      )}
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
