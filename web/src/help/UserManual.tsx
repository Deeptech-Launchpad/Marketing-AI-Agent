import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { AlertTriangle, ArrowLeft, ArrowRight, Lightbulb } from 'lucide-react'
import { MANUAL } from './manual'
import type { Block } from './manualTypes'
import './manual.css'

// THE USER MANUAL, INSIDE THE APP (2026-10-01).
//
// Opened from the Help (?) icon in the top bar. One section at a time, so a
// first-time reader is never faced with the whole manual at once, with the
// contents always visible on the left and Previous / Next at the bottom.
//
// The section is in the address (/help#outreach), so a section can be linked
// to, and the browser's Back button goes to the section you were reading.

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'text':
      return <p className="man__text">{block.text}</p>
    case 'heading':
      return <h3 className="man__h3">{block.text}</h3>
    case 'steps':
      return (
        <ol className="man__steps">
          {block.items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      )
    case 'list':
      return (
        <ul className="man__list">
          {block.items.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )
    case 'terms':
      return (
        <dl className="man__terms">
          {block.items.map((t) => (
            <div key={t.term} className="man__term">
              <dt>{t.term}</dt>
              <dd>{t.meaning}</dd>
            </div>
          ))}
        </dl>
      )
    case 'example':
      return (
        <div className="man__example">
          <p className="man__label">{block.title ?? 'Example'}</p>
          <p>{block.text}</p>
        </div>
      )
    case 'tip':
      return (
        <p className="man__callout man__callout--tip">
          <Lightbulb size={14} aria-hidden="true" />
          <span>{block.text}</span>
        </p>
      )
    case 'warning':
      return (
        <p className="man__callout man__callout--warn">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{block.text}</span>
        </p>
      )
  }
}

export function UserManual() {
  const location = useLocation()
  const navigate = useNavigate()
  const top = useRef<HTMLDivElement>(null)

  const wanted = location.hash.replace(/^#/, '')
  const index = Math.max(
    0,
    MANUAL.findIndex((s) => s.id === wanted),
  )
  const section = MANUAL[index]!
  const prev = index > 0 ? MANUAL[index - 1] : null
  const next = index < MANUAL.length - 1 ? MANUAL[index + 1] : null

  const go = (id: string) => navigate({ pathname: '/help', hash: id })

  // Each section starts at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    top.current?.scrollIntoView?.({ block: 'start' })
  }, [section.id])

  return (
    <div className="man" ref={top}>
      <header className="man__head">
        <p className="eyebrow">Help</p>
        <h1 className="man__title">User Manual</h1>
        <p className="man__sub">
          How to use the Marketing AI Agent, step by step — from finding a company to sending its emails.
        </p>
      </header>

      <div className="man__layout">
        <nav className="man__toc" aria-label="Manual contents">
          <ol>
            {MANUAL.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className={`man__tocitem${s.id === section.id ? ' is-active' : ''}`}
                  aria-current={s.id === section.id ? 'page' : undefined}
                  onClick={() => go(s.id)}
                >
                  <span className="man__tocnum mono">{i + 1}</span>
                  <span>{s.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        <article className="man__body" aria-labelledby={`man-${section.id}`}>
          <p className="man__step mono">
            Part {index + 1} of {MANUAL.length}
          </p>
          <h2 id={`man-${section.id}`} className="man__h2">
            {section.title}
          </h2>
          <p className="man__summary">{section.summary}</p>

          {section.blocks.map((b, i) => (
            <BlockView key={i} block={b} />
          ))}

          <footer className="man__pager">
            {prev ? (
              <button type="button" className="btn btn--ghost btn--md" onClick={() => go(prev.id)}>
                <ArrowLeft size={14} aria-hidden="true" /> {prev.title}
              </button>
            ) : (
              <span />
            )}
            {next && (
              <button type="button" className="btn btn--primary btn--md" onClick={() => go(next.id)}>
                Next: {next.title} <ArrowRight size={14} aria-hidden="true" />
              </button>
            )}
          </footer>
        </article>
      </div>
    </div>
  )
}
