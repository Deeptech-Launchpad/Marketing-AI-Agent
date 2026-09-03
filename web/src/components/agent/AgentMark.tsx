import { useReducedMotion } from '../../lib/hooks'
import './agent.css'

// ─────────────────────────────────────────────────────────────────────────
// The AltiusNXT Agent Identity.
//
// One mark, five states, used everywhere the platform is thinking or acting:
// the top bar, engine headers, loading states and the command centre.
//
// The geometry is drawn from the logo's triangular mark — an ascending
// chevron — rather than reproducing the wordmark, which is used as a supplied
// asset elsewhere and never redrawn.
//
// Every state is legible without motion: the ring, the colour and the
// accompanying label carry the state on their own, and `aria-label` says it
// in words for a screen reader.
// ─────────────────────────────────────────────────────────────────────────

export type AgentState = 'idle' | 'thinking' | 'running' | 'success' | 'error'

const LABELS: Record<AgentState, string> = {
  idle: 'Agent idle',
  thinking: 'Agent thinking',
  running: 'Agent running',
  success: 'Agent completed successfully',
  error: 'Agent needs attention',
}

export function AgentMark({
  state = 'idle',
  size = 28,
  /** Progress 0–1. Draws a determinate ring while running. */
  progress,
  title,
}: {
  state?: AgentState
  size?: number
  progress?: number
  title?: string
}) {
  const reduced = useReducedMotion()
  const r = 46
  const circumference = 2 * Math.PI * r

  return (
    <span
      className={`agent agent--${state}${reduced ? ' agent--still' : ''}`}
      style={{ width: size, height: size }}
      role="img"
      aria-label={title ?? LABELS[state]}
      data-state={state}
    >
      <svg viewBox="0 0 120 120" width={size} height={size} aria-hidden="true">
        <defs>
          <linearGradient id="agent-mark-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--agent-hi)" />
            <stop offset="100%" stopColor="var(--agent-lo)" />
          </linearGradient>
        </defs>

        {/* Ambient halo — the breathing glow. */}
        <circle className="agent__halo" cx="60" cy="60" r="52" />

        {/* Resting ring: always present, so the mark reads as a mark even
            when nothing is moving. */}
        <circle className="agent__track" cx="60" cy="60" r={r} />

        {/* Progress ring. Determinate when a caller supplies progress,
            otherwise a travelling arc while running. */}
        <circle
          className="agent__ring"
          cx="60"
          cy="60"
          r={r}
          strokeDasharray={
            progress === undefined
              ? `${circumference * 0.28} ${circumference}`
              : `${circumference * Math.max(0, Math.min(1, progress))} ${circumference}`
          }
          transform="rotate(-90 60 60)"
        />

        {/* The ascending chevron, echoing the logo's triangular mark. */}
        <path className="agent__chevron" d="M60 34 L82 82 L60 70 L38 82 Z" fill="url(#agent-mark-grad)" />

        {/* Orbiting signal — thinking and running only. */}
        <g className="agent__orbit">
          <circle className="agent__particle" cx="60" cy="14" r="4.5" />
        </g>

        {/* Burst — a single expansion on success, then gone. */}
        <circle className="agent__burst" cx="60" cy="60" r={r} />
      </svg>
    </span>
  )
}

/**
 * The agent mark with its state written beside it.
 *
 * Used wherever the state must be readable rather than merely felt — which,
 * under reduced motion, is everywhere.
 */
export function AgentStatus({
  state,
  label,
  size = 20,
}: {
  state: AgentState
  label?: string
  size?: number
}) {
  return (
    <span className="agent-status">
      <AgentMark state={state} size={size} />
      <span className="agent-status__label">{label ?? LABELS[state]}</span>
    </span>
  )
}
