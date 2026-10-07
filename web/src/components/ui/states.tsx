import type { ReactNode } from 'react'
import { AlertTriangle, Ban, Inbox, RefreshCw } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { AgentMark } from '../agent/AgentMark'
import { Button } from './primitives'
import './ui.css'

// ─────────────────────────────────────────────────────────────────────────
// The four honest states.
//
// A screen is either loading, empty, blocked or broken — and each of those is
// a different thing to tell somebody. The platform never collapses them into
// "Something went wrong", because that sentence tells an operator nothing and
// an engineer less.
//
// Every failure answers four questions: what failed, why, what it affects,
// and what can be done about it.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Loading, in the engine's own visual language.
 *
 * The caller passes the engine's signature animation, so waiting for the
 * audit looks like scanning and waiting for discovery looks like a sweep.
 * There is no generic spinner and no "Loading…".
 */
export function LoadingState({
  what,
  visual,
  rows = 3,
}: {
  /** What is being loaded, in the platform's words. */
  what: string
  visual?: ReactNode
  rows?: number
}) {
  return (
    <div className="state state--loading" role="status" aria-live="polite">
      {visual && <div className="state__visual">{visual}</div>}
      <div className="state__body">
        <p className="state__title">
          <AgentMark state="thinking" size={16} />
          {what}
        </p>
        <div className="state__skeletons" aria-hidden="true">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} className="skeleton" style={{ width: `${92 - i * 14}%` }} />
          ))}
        </div>
      </div>
    </div>
  )
}

/** Nothing has happened here yet — which is not a failure. */
export function EmptyState({
  title,
  detail,
  action,
  icon: Icon = Inbox,
}: {
  title: string
  detail?: ReactNode
  action?: ReactNode
  icon?: typeof Inbox
}) {
  return (
    <div className="state state--empty">
      <Icon size={22} className="state__icon" aria-hidden="true" />
      <p className="state__title">{title}</p>
      {detail && <p className="state__detail">{detail}</p>}
      {action && <div className="state__action">{action}</div>}
    </div>
  )
}

/**
 * A capability that is deliberately unavailable.
 *
 * Distinct from an error: nothing is broken, something is simply not
 * configured or not permitted. It is styled as attention rather than alarm,
 * and it never animates — a blocked state that pulses reads as progress.
 */
export function BlockedState({
  what,
  why,
  affects,
  remediation,
  action,
}: {
  what: string
  why: string
  affects?: string
  remediation?: string
  action?: ReactNode
}) {
  return (
    <div className="state state--blocked">
      <div className="state__head">
        <Ban size={16} className="state__icon" aria-hidden="true" />
        <p className="state__title">{what}</p>
      </div>
      <p className="state__detail">{why}</p>
      {affects && (
        <p className="state__meta">
          <span className="eyebrow">Affects</span> {affects}
        </p>
      )}
      {remediation && (
        <p className="state__meta">
          <span className="eyebrow">To resolve</span> {remediation}
        </p>
      )}
      {action && <div className="state__action">{action}</div>}
    </div>
  )
}

/**
 * Something actually failed.
 *
 * Reads the ApiError so the message is the backend's own words, and offers a
 * retry only where retrying could plausibly help.
 */
export function ErrorState({
  error,
  what,
  affects,
  onRetry,
}: {
  error: Error | ApiError | null
  /** What the interface was trying to do. */
  what: string
  affects?: string
  onRetry?: () => void
}) {
  const api = error instanceof ApiError ? error : null
  const permission = api?.isForbidden

  const why = permission
    ? api.message
    : api?.status === 0
      ? api.message
      : (error?.message ?? 'The service returned no explanation.')

  const remediation = permission
    ? 'Ask an administrator to grant your account the permission named above.'
    : api?.status === 0
      ? 'Check your internet connection, then click Try again. Nothing was lost.'
      : api?.status === 404
        ? 'The record may have been removed, or the identifier may be wrong.'
        : 'If this keeps happening, quote the request id below to engineering.'

  return (
    <div className="state state--error" role="alert">
      <div className="state__head">
        <AlertTriangle size={16} className="state__icon" aria-hidden="true" />
        <p className="state__title">{what}</p>
      </div>
      <p className="state__detail">{why}</p>
      {affects && (
        <p className="state__meta">
          <span className="eyebrow">Affects</span> {affects}
        </p>
      )}
      <p className="state__meta">
        <span className="eyebrow">To resolve</span> {remediation}
      </p>
      {(api?.requestId || api?.code) && (
        <p className="state__meta mono state__ref">
          {api.code}
          {api.requestId ? ` · ${api.requestId}` : ''}
        </p>
      )}
      {onRetry && !permission && (
        <div className="state__action">
          <Button icon={RefreshCw} onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Chooses the right state for an async result.
 *
 * Keeps every screen consistent about the difference between "still loading",
 * "nothing here", "broken" and "here it is".
 */
export function AsyncBoundary<T>({
  state,
  what,
  visual,
  empty,
  isEmpty,
  children,
}: {
  state: { data: T | null; loading: boolean; error: Error | null; refresh: () => void }
  what: string
  visual?: ReactNode
  empty?: ReactNode
  isEmpty?: (data: T) => boolean
  children: (data: T) => ReactNode
}) {
  if (state.loading && !state.data) return <LoadingState what={what} visual={visual} />
  if (state.error) return <ErrorState error={state.error} what={what} onRetry={state.refresh} />
  if (!state.data) return <>{empty ?? <EmptyState title="Nothing to show yet." />}</>
  if (isEmpty?.(state.data)) return <>{empty ?? <EmptyState title="Nothing to show yet." />}</>
  return <>{children(state.data)}</>
}

/**
 * A screen refusing to draw another company's evidence.
 *
 * Deliberately shows the ids rather than a soft apology: when this appears,
 * somebody needs to know WHICH record was about to be shown under the wrong
 * customer's name. Nothing of the foreign record is rendered alongside it.
 */
export function LineageMismatch({
  what,
  expected,
  found,
  onReload,
}: {
  what: string
  expected: string
  found: string | null
  onReload?: () => void
}) {
  return (
    <BlockedState
      what="Data lineage mismatch"
      why={`The ${what} that loaded belongs to a different company than the one selected, so it has not been displayed.`}
      affects={`Selected company ${expected}; the record names ${found ?? 'no company'}.`}
      remediation="Reload this workspace for the selected company. If it keeps happening, quote both ids to engineering."
      action={
        onReload ? (
          <Button icon={RefreshCw} onClick={onReload}>
            Reload for the selected company
          </Button>
        ) : undefined
      }
    />
  )
}
