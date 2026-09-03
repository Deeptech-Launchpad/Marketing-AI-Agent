import { useEffect, useState } from 'react'
import { useReducedMotion } from '../../lib/hooks'
import './ui.css'

// ─────────────────────────────────────────────────────────────────────────
// ScoreFill — the scoring signature.
//
// The ring sweeps to the score once, on arrival, and then holds. The number
// counts with it so the two never disagree mid-animation.
//
// Under reduced motion both jump straight to the final value: the score is
// information, and it is never withheld for the sake of an entrance.
// ─────────────────────────────────────────────────────────────────────────

export function ScoreRing({
  score,
  max = 100,
  level,
  threshold,
  size = 190,
  label = 'Intent score',
  accent = 'var(--accent)',
}: {
  score: number
  max?: number
  level?: string
  /** Draws a tick where the qualification threshold sits. */
  threshold?: number
  size?: number
  label?: string
  accent?: string
}) {
  const reduced = useReducedMotion()
  const [shown, setShown] = useState(reduced ? score : 0)

  useEffect(() => {
    if (reduced) {
      setShown(score)
      return
    }
    let frame = 0
    const start = performance.now()
    const duration = 900
    const from = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration)
      // Ease-out so it decelerates into the value rather than snapping.
      const eased = 1 - Math.pow(1 - p, 3)
      setShown(Math.round(from + (score - from) * eased))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [score, reduced])

  const r = 78
  const circumference = 2 * Math.PI * r
  const pct = Math.max(0, Math.min(1, shown / max))
  const offset = circumference * (1 - pct)
  const thresholdAngle = threshold !== undefined ? (threshold / max) * 360 - 90 : null

  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={`${label}: ${score} out of ${max}`}>
        <circle className="ring__track" cx="100" cy="100" r={r} />
        <circle
          className="ring__fill"
          cx="100"
          cy="100"
          r={r}
          stroke={accent}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 100 100)"
        />
        {thresholdAngle !== null && (
          <line
            className="ring__threshold"
            x1={100 + Math.cos((thresholdAngle * Math.PI) / 180) * (r - 11)}
            y1={100 + Math.sin((thresholdAngle * Math.PI) / 180) * (r - 11)}
            x2={100 + Math.cos((thresholdAngle * Math.PI) / 180) * (r + 11)}
            y2={100 + Math.sin((thresholdAngle * Math.PI) / 180) * (r + 11)}
          />
        )}
      </svg>
      <div className="ring__center">
        <span className="ring__label">{label}</span>
        <span className="ring__value tnum" style={{ color: accent }}>
          {shown}
          <span className="ring__max">/{max}</span>
        </span>
        {level && <span className="ring__level">{level}</span>}
      </div>
    </div>
  )
}

/**
 * ThresholdCross — the qualification signature.
 *
 * Shows the score beside the threshold it was measured against, and animates
 * the crossing once when the lead qualifies. When it has not crossed, nothing
 * moves and the gap is stated plainly.
 */
export function ThresholdMeter({
  score,
  threshold,
  qualified,
  accent = 'var(--e-qualification)',
}: {
  score: number
  threshold: number
  qualified: boolean
  accent?: string
}) {
  const reduced = useReducedMotion()
  const difference = score - threshold

  return (
    <div className="threshold">
      <div className="threshold__pair">
        <div className="threshold__stat">
          <span className="threshold__cap">Intent score</span>
          <span className="threshold__num tnum" style={{ color: qualified ? accent : 'var(--text)' }}>
            {score}
          </span>
        </div>
        <span className="threshold__divider" aria-hidden="true" />
        <div className="threshold__stat threshold__stat--muted">
          <span className="threshold__cap">Threshold</span>
          <span className="threshold__num tnum">{threshold}</span>
        </div>
      </div>

      <div className="threshold__bar" aria-hidden="true">
        <div className="threshold__fill" style={{ width: `${Math.min(100, score)}%`, background: accent }} />
        <div className="threshold__mark" style={{ left: `${Math.min(100, threshold)}%` }} />
      </div>

      <p className="threshold__reading">
        {difference >= 0 ? (
          <>
            <strong className="tnum">+{difference}</strong> above the threshold
          </>
        ) : (
          <>
            <strong className="tnum">{Math.abs(difference)}</strong> below the threshold
          </>
        )}
      </p>

      {qualified && (
        <div className={`threshold__badge${reduced ? '' : ' threshold__badge--enter'}`}>
          {!reduced && <span className="threshold__halo" aria-hidden="true" />}
          <span className="threshold__badge-text">HIGH-INTENT</span>
        </div>
      )}
    </div>
  )
}
