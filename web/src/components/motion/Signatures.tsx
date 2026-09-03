import { useMemo } from 'react'
import { useTheme } from '../../lib/theme'
import { useCanvasLoop, useReducedMotion } from '../../lib/hooks'
import './motion.css'

// ─────────────────────────────────────────────────────────────────────────
// Signature motion.
//
// Each engine gets one recognisable movement, drawn from the visual language
// of what it actually does: a radar sweeps because discovery searches, a beam
// scans because the auditor crawls, a payload travels because the CRM sync
// carries something somewhere.
//
// Every canvas here stops when it scrolls out of view, when the tab is
// hidden, or when the viewer has asked for reduced motion — in which case it
// paints one static frame so the visual still reads as itself.
//
// None of these draw data. They are atmosphere behind real numbers, so a
// paused animation never hides a value.
// ─────────────────────────────────────────────────────────────────────────

interface SigProps {
  accent: string
  /** Turns the loop off without unmounting, e.g. when a panel is idle. */
  active?: boolean
  className?: string
  /** Described for screen readers, since the visual carries no state. */
  label?: string
}

function rgbaBase(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.min(1, Math.max(0, alpha))})`
}

/**
 * A theme-aware `rgba` for the signature canvases.
 *
 * These alphas were tuned against a near-black ground, where a stroke at 0.14
 * reads clearly. The same stroke on white is invisible, so on the light theme
 * every alpha is scaled up. Shadowing the module-level name means each draw
 * function keeps the values it was designed with and simply lands correctly on
 * whichever ground it is on.
 */
function useSigRgba(): (hex: string, alpha: number) => string {
  const { theme } = useTheme()
  return useMemo(() => {
    const ink = theme === 'light' ? 1.55 : 1
    return (hex: string, alpha: number) => rgbaBase(hex, alpha * ink)
  }, [theme])
}

/** Semantic colours a signature needs, at the value its theme can carry. */
function useSigWarn(): string {
  const { theme } = useTheme()
  return theme === 'light' ? '#a16207' : '#eab308'
}

/** Deterministic pseudo-random, so a visual is identical on every render. */
function seeded(i: number, salt = 1): number {
  const x = Math.sin(i * 12.9898 * salt) * 43758.5453
  return x - Math.floor(x)
}

// ── PROSPECT: a radar sweep over scattered candidate nodes ───────────────

export function RadarSweep({ accent, active = true, className, label }: SigProps) {
  const rgba = useSigRgba()
  const nodes = useMemo(
    () =>
      Array.from({ length: 90 }, (_, i) => {
        const angle = seeded(i, 1) * Math.PI * 2
        const radius = Math.sqrt(seeded(i, 2)) * 0.92
        return { angle, radius, size: 1 + seeded(i, 3) * 2.2 }
      }),
    [],
  )

  const { canvasRef, wrapRef } = useCanvasLoop(
    (ctx, t, w, h) => {
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2
      const cy = h / 2
      const R = Math.min(w, h) / 2 - 8
      if (R <= 0) return

      // Range rings.
      ctx.strokeStyle = rgba(accent, 0.14)
      ctx.lineWidth = 1
      for (let i = 1; i <= 4; i++) {
        ctx.beginPath()
        ctx.arc(cx, cy, (R * i) / 4, 0, Math.PI * 2)
        ctx.stroke()
      }
      // Cross hairs.
      ctx.strokeStyle = rgba(accent, 0.1)
      ctx.beginPath()
      ctx.moveTo(cx - R, cy)
      ctx.lineTo(cx + R, cy)
      ctx.moveTo(cx, cy - R)
      ctx.lineTo(cx, cy + R)
      ctx.stroke()

      const sweep = (t * 0.55) % (Math.PI * 2)

      // The beam: a soft wedge trailing the leading edge.
      const grad = ctx.createConicGradient?.(sweep - 0.6, cx, cy)
      if (grad) {
        grad.addColorStop(0, rgba(accent, 0))
        grad.addColorStop(0.09, rgba(accent, 0.22))
        grad.addColorStop(0.1, rgba(accent, 0))
        ctx.fillStyle = grad
        ctx.beginPath()
        ctx.arc(cx, cy, R, 0, Math.PI * 2)
        ctx.fill()
      }

      // Leading edge.
      ctx.strokeStyle = rgba(accent, 0.85)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(cx, cy)
      ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R)
      ctx.stroke()

      // Nodes brighten as the beam passes and fade behind it.
      for (const node of nodes) {
        const x = cx + Math.cos(node.angle) * node.radius * R
        const y = cy + Math.sin(node.angle) * node.radius * R
        let delta = sweep - node.angle
        while (delta < 0) delta += Math.PI * 2
        const freshness = Math.max(0, 1 - delta / 1.9)
        ctx.fillStyle = rgba(accent, 0.14 + freshness * 0.8)
        ctx.beginPath()
        ctx.arc(x, y, node.size * (1 + freshness * 0.5), 0, Math.PI * 2)
        ctx.fill()
      }
    },
    { active },
  )

  return (
    <div ref={wrapRef} className={`sig sig--radar ${className ?? ''}`} role="img" aria-label={label ?? 'Discovery radar'}>
      <canvas ref={canvasRef} />
    </div>
  )
}

// ── AUDIT: an inspection beam travelling over a wireframe of page nodes ──

export function ScanBeam({ accent, active = true, className, label }: SigProps) {
  const rgba = useSigRgba()
  const pages = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        x: 0.06 + seeded(i, 5) * 0.88,
        y: 0.12 + seeded(i, 7) * 0.76,
        w: 0.05 + seeded(i, 11) * 0.05,
      })),
    [],
  )

  const { canvasRef, wrapRef } = useCanvasLoop(
    (ctx, t, w, h) => {
      ctx.clearRect(0, 0, w, h)

      // A faint grid, standing in for the site's structure.
      ctx.strokeStyle = rgba(accent, 0.07)
      ctx.lineWidth = 1
      for (let x = 0; x <= w; x += 34) {
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
      }
      for (let y = 0; y <= h; y += 34) {
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(w, y)
        ctx.stroke()
      }

      const beamY = ((t * 0.24) % 1.25) * h - 0.1 * h

      // Page nodes light as the beam crosses them.
      for (const p of pages) {
        const px = p.x * w
        const py = p.y * h
        const pw = p.w * w
        const ph = pw * 0.72
        const dist = Math.abs(py - beamY)
        const lit = Math.max(0, 1 - dist / 70)

        ctx.strokeStyle = rgba(accent, 0.2 + lit * 0.75)
        ctx.lineWidth = 1
        ctx.strokeRect(px, py, pw, ph)
        ctx.fillStyle = rgba(accent, 0.04 + lit * 0.16)
        ctx.fillRect(px, py, pw, ph)

        // Content lines inside each page.
        ctx.fillStyle = rgba(accent, 0.14 + lit * 0.4)
        for (let l = 0; l < 3; l++) {
          ctx.fillRect(px + 4, py + 6 + l * 6, pw * (0.7 - l * 0.14), 1.5)
        }
      }

      // The beam itself.
      const grad = ctx.createLinearGradient(0, beamY - 26, 0, beamY + 26)
      grad.addColorStop(0, rgba(accent, 0))
      grad.addColorStop(0.5, rgba(accent, 0.5))
      grad.addColorStop(1, rgba(accent, 0))
      ctx.fillStyle = grad
      ctx.fillRect(0, beamY - 26, w, 52)

      ctx.strokeStyle = rgba(accent, 0.95)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(0, beamY)
      ctx.lineTo(w, beamY)
      ctx.stroke()
    },
    { active },
  )

  return (
    <div ref={wrapRef} className={`sig sig--scan ${className ?? ''}`} role="img" aria-label={label ?? 'Crawl in progress'}>
      <canvas ref={canvasRef} />
    </div>
  )
}

// ── INTENT: a signal waveform ────────────────────────────────────────────

export function SignalWave({ accent, active = true, className, label }: SigProps) {
  const rgba = useSigRgba()
  const { canvasRef, wrapRef } = useCanvasLoop(
    (ctx, t, w, h) => {
      ctx.clearRect(0, 0, w, h)
      const mid = h / 2

      // Baseline.
      ctx.strokeStyle = rgba(accent, 0.18)
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, mid)
      ctx.lineTo(w, mid)
      ctx.stroke()

      // Three bursts of activity along the line, breathing at their own rates.
      const bursts = [0.22, 0.52, 0.78]
      ctx.lineWidth = 2
      ctx.strokeStyle = rgba(accent, 0.95)
      ctx.shadowColor = rgba(accent, 0.6)
      ctx.shadowBlur = 12
      ctx.beginPath()

      for (let x = 0; x <= w; x++) {
        const nx = x / w
        let amp = 0.05
        bursts.forEach((b, i) => {
          const d = Math.abs(nx - b)
          amp += Math.exp(-(d * d) / 0.004) * (0.45 + 0.2 * Math.sin(t * 1.4 + i * 2))
        })
        const y =
          mid -
          Math.sin(nx * 58 + t * 3.1) * amp * (h * 0.36) -
          Math.sin(nx * 17 - t * 1.7) * amp * (h * 0.1)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.shadowBlur = 0
    },
    { active },
  )

  return (
    <div ref={wrapRef} className={`sig sig--wave ${className ?? ''}`} role="img" aria-label={label ?? 'Signal activity'}>
      <canvas ref={canvasRef} />
    </div>
  )
}

// ── DECISION MAKERS: a relationship graph settling around a company ──────

export function RelationshipGraph({
  accent,
  active = true,
  className,
  label,
  count = 0,
}: SigProps & { count?: number }) {
  const rgba = useSigRgba()
  const people = Math.max(3, Math.min(count || 6, 10))
  const { canvasRef, wrapRef } = useCanvasLoop(
    (ctx, t, w, h) => {
      ctx.clearRect(0, 0, w, h)
      const cx = w / 2
      const cy = h / 2
      const R = Math.min(w, h) * 0.34

      // The constellation turns, so the map reads as being worked over rather
      // than printed once. Slow enough to stay background, fast enough to see.
      const spin = t * 0.1

      for (let i = 0; i < people; i++) {
        const base = (i / people) * Math.PI * 2
        const drift = Math.sin(t * 0.5 + i * 1.7) * 0.13
        const angle = base + spin + drift
        const rad = R * (0.78 + seeded(i, 13) * 0.35) * (1 + Math.sin(t * 0.7 + i) * 0.06)
        const x = cx + Math.cos(angle) * rad
        const y = cy + Math.sin(angle) * rad * 0.72
        const mx = (cx + x) / 2
        const my = (cy + y) / 2 - 18

        const pulse = (Math.sin(t * 1.1 - i * 0.7) + 1) / 2

        // Edge.
        ctx.strokeStyle = rgba(accent, 0.14 + pulse * 0.28)
        ctx.lineWidth = 1 + pulse * 0.9
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.quadraticCurveTo(mx, my, x, y)
        ctx.stroke()

        // A probe travelling out along the edge. This is the movement the eye
        // actually catches, and it carries the idea the engine is walking the
        // account rather than showing a still.
        const u = (t * 0.4 + i / people) % 1
        const k = 1 - u
        const px = k * k * cx + 2 * k * u * mx + u * u * x
        const py = k * k * cy + 2 * k * u * my + u * u * y
        const fade = Math.sin(u * Math.PI)
        ctx.fillStyle = rgba(accent, 0.9 * fade)
        ctx.shadowColor = rgba(accent, 0.8)
        ctx.shadowBlur = 6 * fade
        ctx.beginPath()
        ctx.arc(px, py, 2.8, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0

        // Person node, flaring as the probe lands on it.
        const land = Math.max(0, 1 - (1 - u) * 7)
        ctx.fillStyle = rgba(accent, 0.5 + pulse * 0.4)
        ctx.shadowColor = rgba(accent, 0.6)
        ctx.shadowBlur = 8 + land * 14
        ctx.beginPath()
        ctx.arc(x, y, 5.5 + land * 2.6, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }

      // The company at the centre.
      ctx.fillStyle = rgba(accent, 0.95)
      ctx.shadowColor = rgba(accent, 0.8)
      ctx.shadowBlur = 18
      ctx.beginPath()
      ctx.arc(cx, cy, 9, 0, Math.PI * 2)
      ctx.fill()
      ctx.shadowBlur = 0
    },
    { active },
  )

  return (
    <div ref={wrapRef} className={`sig sig--graph ${className ?? ''}`} role="img" aria-label={label ?? 'Relationship map'}>
      <canvas ref={canvasRef} />
    </div>
  )
}

// ── CRM: a payload travelling from the platform into the sync layer ──────

export function SyncFlow({
  accent,
  active = true,
  className,
  label,
  blocked = false,
}: SigProps & { blocked?: boolean }) {
  const rgba = useSigRgba()
  const warn = useSigWarn()
  const { canvasRef, wrapRef } = useCanvasLoop(
    (ctx, t, w, h) => {
      ctx.clearRect(0, 0, w, h)
      const cy = h / 2
      const lanes = [cy - h * 0.22, cy, cy + h * 0.22]
      const stop = w * 0.52

      lanes.forEach((y, i) => {
        // The lane.
        ctx.strokeStyle = rgba(accent, 0.14)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(blocked ? stop : w, y)
        ctx.stroke()

        // Packets. When the handoff is blocked they stall at the boundary and
        // queue instead of crossing — the movement itself says "held", and it
        // must never look like a completed sync.
        for (let p = 0; p < 3; p++) {
          const speed = 0.16 + i * 0.03
          const raw = (t * speed + p / 3 + i * 0.2) % 1
          const x = blocked ? Math.min(raw * w, stop - 8 - p * 11) : raw * w
          const fade = blocked && raw * w > stop ? 0.35 : 1
          ctx.fillStyle = rgba(accent, 0.85 * fade)
          ctx.shadowColor = rgba(accent, 0.7)
          ctx.shadowBlur = 8
          ctx.fillRect(x - 3, y - 3, 6, 6)
          ctx.shadowBlur = 0
        }
      })

      if (blocked) {
        // A held boundary, drawn as a dashed wall rather than a broken pipe.
        ctx.setLineDash([4, 5])
        ctx.strokeStyle = rgba(warn, 0.75)
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(stop, h * 0.16)
        ctx.lineTo(stop, h * 0.84)
        ctx.stroke()
        ctx.setLineDash([])
      }
    },
    { active },
  )

  return (
    <div
      ref={wrapRef}
      className={`sig sig--sync ${className ?? ''}`}
      role="img"
      aria-label={label ?? (blocked ? 'Handoff prepared and held' : 'Payload in transit')}
    >
      <canvas ref={canvasRef} />
    </div>
  )
}

// ── ENGAGEMENT: pulses travelling along a timeline axis ──────────────────

export function TimelinePulse({ accent, active = true, className, label }: SigProps) {
  const rgba = useSigRgba()
  const { canvasRef, wrapRef } = useCanvasLoop(
    (ctx, t, w, h) => {
      ctx.clearRect(0, 0, w, h)
      const y = h / 2

      ctx.strokeStyle = rgba(accent, 0.22)
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(w, y)
      ctx.stroke()

      for (let i = 0; i < 7; i++) {
        const x = (0.08 + i * 0.14) * w
        const phase = (t * 0.8 - i * 0.32) % 3
        const glow = phase > 0 && phase < 1 ? Math.sin(phase * Math.PI) : 0
        ctx.fillStyle = rgba(accent, 0.4 + glow * 0.6)
        ctx.shadowColor = rgba(accent, 0.8)
        ctx.shadowBlur = glow * 14
        ctx.beginPath()
        ctx.arc(x, y, 4 + glow * 2.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    },
    { active },
  )

  return (
    <div ref={wrapRef} className={`sig sig--timeline ${className ?? ''}`} role="img" aria-label={label ?? 'Engagement activity'}>
      <canvas ref={canvasRef} />
    </div>
  )
}

// ── ENRICHMENT: layered panels revealing one after another ───────────────

export function LayerReveal({ accent, className, layers = 3 }: SigProps & { layers?: number }) {
  const rgba = useSigRgba()
  const reduced = useReducedMotion()
  return (
    <div className={`sig-layers ${className ?? ''}`} role="img" aria-label="Data layers">
      {Array.from({ length: layers }, (_, i) => (
        <span
          key={i}
          className="sig-layers__plate"
          style={{
            ['--i' as string]: i,
            borderColor: rgba(accent, 0.4),
            background: `linear-gradient(135deg, ${rgba(accent, 0.16)}, transparent 70%)`,
            animation: reduced ? 'none' : undefined,
          }}
        />
      ))}
    </div>
  )
}

// ── OUTREACH: a sequence path with a travelling message ──────────────────

export function SequencePath({ accent, active = true, className, label }: SigProps) {
  const rgba = useSigRgba()
  const { canvasRef, wrapRef } = useCanvasLoop(
    (ctx, t, w, h) => {
      ctx.clearRect(0, 0, w, h)

      const path = (x: number): number =>
        h / 2 + Math.sin((x / w) * Math.PI * 2) * h * 0.26

      // The route.
      ctx.strokeStyle = rgba(accent, 0.28)
      ctx.lineWidth = 2
      ctx.beginPath()
      for (let x = 0; x <= w; x += 2) {
        const y = path(x)
        if (x === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()

      // Messages travelling it.
      for (let m = 0; m < 3; m++) {
        const p = (t * 0.18 + m / 3) % 1
        const x = p * w
        const y = path(x)
        const alpha = Math.sin(p * Math.PI)
        ctx.fillStyle = rgba(accent, 0.9 * alpha)
        ctx.shadowColor = rgba(accent, 0.9)
        ctx.shadowBlur = 12 * alpha
        ctx.beginPath()
        ctx.arc(x, y, 4.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.shadowBlur = 0
      }
    },
    { active },
  )

  return (
    <div ref={wrapRef} className={`sig sig--sequence ${className ?? ''}`} role="img" aria-label={label ?? 'Sequence path'}>
      <canvas ref={canvasRef} />
    </div>
  )
}
