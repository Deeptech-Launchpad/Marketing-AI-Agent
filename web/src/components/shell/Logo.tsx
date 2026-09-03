import logoUrl from '/altiusnxt-logo.png'
import './shell.css'

// ─────────────────────────────────────────────────────────────────────────
// The official AltiusNXT logo.
//
// This is the supplied asset, rendered as supplied — not redrawn, not
// recoloured, not replaced by a lookalike.
//
// The wordmark is dark navy and grey, made for a light ground, and this
// interface is dark. Rather than filtering the artwork (which would alter the
// brand colours) it sits on a light plate, the way a printed logo sits on
// stationery. The brand stays exactly itself; only its backing changes.
// ─────────────────────────────────────────────────────────────────────────

export function Logo({ height = 22, plate = true }: { height?: number; plate?: boolean }) {
  return (
    <span className={`logo${plate ? ' logo--plate' : ''}`}>
      <img src={logoUrl} alt="AltiusNXT" height={height} style={{ height }} />
    </span>
  )
}
