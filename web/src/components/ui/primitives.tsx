import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, CircleDashed, CircleDot, Clock, Loader2, XCircle } from 'lucide-react'
import type { UiStatus } from '../../lib/types'
import './ui.css'

// ─────────────────────────────────────────────────────────────────────────
// The shared component language.
//
// Every engine builds from these, so a panel, a metric and a status read the
// same way on all twelve screens and an operator learns the interface once.
// ─────────────────────────────────────────────────────────────────────────

export function Panel({
  title,
  subtitle,
  actions,
  children,
  padded = true,
  className,
}: {
  title?: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  children: ReactNode
  padded?: boolean
  className?: string
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {(title || actions) && (
        <header className="panel__head">
          <div className="panel__titles">
            {title && <h2 className="panel__title">{title}</h2>}
            {subtitle && <p className="panel__sub">{subtitle}</p>}
          </div>
          {actions && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'panel__body' : 'panel__body panel__body--flush'}>{children}</div>
    </section>
  )
}

// ── Status ──────────────────────────────────────────────────────────────
//
// Status is carried by an icon, a word and a colour together. The motion is
// the fourth channel, never the only one — a running job says "Running" as
// well as spinning, and a blocked one is a still amber dot that says
// "Blocked" rather than an animation that could be mistaken for progress.

const STATUS_META: Record<UiStatus, { label: string; icon: typeof CheckCircle2 }> = {
  ready: { label: 'Ready', icon: CircleDot },
  running: { label: 'Running', icon: Loader2 },
  complete: { label: 'Complete', icon: CheckCircle2 },
  blocked: { label: 'Blocked', icon: AlertTriangle },
  review: { label: 'In review', icon: Clock },
  error: { label: 'Error', icon: XCircle },
  idle: { label: 'Not started', icon: CircleDashed },
}

/** Maps any backend status string onto the interface's six-state vocabulary. */
export function toUiStatus(raw: string | null | undefined): UiStatus {
  const s = (raw ?? '').toLowerCase()
  if (!s) return 'idle'
  if (/(^|_)(running|syncing|sending|validating|in_progress|queued|scheduled)/.test(s)) return 'running'
  if (/(complete|completed|succeeded|success|synced|approved|sent|created|delivered|ready_to_send|recorded_in_app)/.test(s))
    return 'complete'
  if (/(blocked|suppressed|not_configured|unavailable|write_not_supported|skipped|manual_required|not_supported|unauthorized)/.test(s))
    return 'blocked'
  if (/(review|pending_review|ready_for_approval|changes_requested|awaiting)/.test(s)) return 'review'
  if (/(failed|error|rejected|de_qualified|bounced)/.test(s)) return 'error'
  if (/(ready|qualified|active|draft|pending|prepared|open)/.test(s)) return 'ready'
  return 'idle'
}

export function StatusBadge({
  status,
  label,
  size = 'md',
}: {
  status: UiStatus
  label?: string
  size?: 'sm' | 'md'
}) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <span className={`status status--${status} status--${size}`}>
      <Icon size={size === 'sm' ? 11 : 13} className="status__icon" aria-hidden="true" />
      <span>{label ?? meta.label}</span>
    </span>
  )
}

/** A bare state dot, for dense lists where a full badge would crowd. */
export function StatusDot({ status, title }: { status: UiStatus; title?: string }) {
  return <span className={`dot dot--${status}`} title={title ?? STATUS_META[status].label} aria-label={title ?? STATUS_META[status].label} role="img" />
}

// ── Metric ──────────────────────────────────────────────────────────────

export function Metric({
  label,
  value,
  hint,
  accent,
  size = 'md',
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  accent?: boolean
  size?: 'sm' | 'md' | 'lg'
}) {
  return (
    <div className={`metric metric--${size}`}>
      <span className="metric__label">{label}</span>
      <span className={`metric__value tnum${accent ? ' metric__value--accent' : ''}`}>{value}</span>
      {hint && <span className="metric__hint">{hint}</span>}
    </div>
  )
}

// ── Chips ───────────────────────────────────────────────────────────────

/**
 * Marks a value the business has not signed off.
 *
 * Used on every threshold, weight and SLA. The platform's own APIs report
 * these as provisional, and the interface repeats it rather than presenting a
 * placeholder as settled policy.
 */
export function ProvisionalChip({ what = 'Provisional' }: { what?: string }) {
  return (
    <span className="chip chip--provisional" title="Not approved by the business. A default, pending a decision.">
      {what}
    </span>
  )
}

export function Chip({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'info'
  title?: string
}) {
  return (
    <span className={`chip chip--${tone}`} title={title}>
      {children}
    </span>
  )
}

// ── Buttons ─────────────────────────────────────────────────────────────

export function Button({
  children,
  onClick,
  variant = 'ghost',
  size = 'md',
  disabled,
  title,
  type = 'button',
  icon: Icon,
  busy,
}: {
  children?: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'quiet' | 'danger'
  size?: 'sm' | 'md'
  disabled?: boolean
  title?: string
  type?: 'button' | 'submit'
  icon?: typeof CheckCircle2
  busy?: boolean
}) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} btn--${size}`}
      onClick={onClick}
      disabled={disabled || busy}
      title={title}
    >
      {busy ? (
        <Loader2 size={14} className="btn__spin" aria-hidden="true" />
      ) : (
        Icon && <Icon size={14} aria-hidden="true" />
      )}
      {children}
    </button>
  )
}

// ── Layout helpers ──────────────────────────────────────────────────────

export function MetricRow({ children }: { children: ReactNode }) {
  return <div className="metric-row">{children}</div>
}

export function Field({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="field">
      <span className="field__label">{label}</span>
      <span className={`field__value${mono ? ' mono' : ''}`}>{value ?? <Unset />}</span>
    </div>
  )
}

/**
 * The absence of a value, said plainly.
 *
 * Used everywhere the backend returned null. "Not recorded" is a fact; a dash
 * or a zero would be an invention.
 */
export function Unset({ what = 'Not recorded' }: { what?: string }) {
  return <span className="unset">{what}</span>
}
