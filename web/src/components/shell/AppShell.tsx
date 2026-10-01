import { useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { HelpCircle, LayoutGrid, LogOut, PanelLeftClose, PanelLeftOpen, PanelRightClose, Search, SlidersHorizontal } from 'lucide-react'
import { ENGINES, brandAccent, engineAccent, engineForPath, rgbTriple } from '../../lib/engines'
import { useTheme } from '../../lib/theme'
import { ThemeSwitch } from './ThemeSwitch'
import { useAuth } from '../../lib/auth'
import { useCompany } from '../../lib/companyContext'
import { AgentMark } from '../agent/AgentMark'
import { Logo } from './Logo'
import { ContextPanel } from './ContextPanel'
import { RouteBoundary } from './RouteBoundary'
import './shell.css'

// ─────────────────────────────────────────────────────────────────────────
// The shell.
//
//   left    the engines, always in the same order as the pipeline
//   centre  the active engine's workspace
//   right   the shared company context, which follows you between engines
//
// The frame never moves. Only the centre changes, so an operator keeps their
// bearings — and the selected company stays on screen the whole way through,
// which is the platform's central promise.
//
// The active engine's accent is published onto the shell as a CSS variable,
// so every accent-aware component downstream re-tints without prop-drilling a
// colour through every screen.
// ─────────────────────────────────────────────────────────────────────────

export function AppShell() {
  const location = useLocation()
  const engine = engineForPath(location.pathname)
  const { principal, signOut } = useAuth()
  const { theme } = useTheme()
  const { company } = useCompany()

  const [navOpen, setNavOpen] = useState(true)
  const [contextOpen, setContextOpen] = useState(true)

  // Collapse the side panels on narrower screens, keeping the workspace
  // legible at 1024px without losing the engine hierarchy.
  useEffect(() => {
    const apply = () => {
      setNavOpen(window.innerWidth >= 1180)
      setContextOpen(window.innerWidth >= 1360)
    }
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  const accent = engine ? engineAccent(engine, theme) : brandAccent(theme)

  return (
    <div
      className={`shell${navOpen ? '' : ' shell--nav-collapsed'}${contextOpen ? '' : ' shell--no-context'}`}
      style={{ ['--accent' as string]: accent, ['--accent-rgb' as string]: rgbTriple(accent) }}
    >
      {/* ── Left: engine navigation ─────────────────────────────────── */}
      <nav className="nav" aria-label="Engines">
        <div className="nav__brand">
          <Logo height={navOpen ? 20 : 18} />
          {navOpen && <span className="nav__brand-sub">Marketing AI</span>}
        </div>

        <NavLink to="/" end className={({ isActive }) => `nav__item nav__home${isActive ? ' is-active' : ''}`}>
          <LayoutGrid size={16} aria-hidden="true" />
          {navOpen && <span>Command Centre</span>}
        </NavLink>

        {navOpen && <p className="nav__section">Engines</p>}

        <ul className="nav__list">
          {ENGINES.map((e) => {
            const Icon = e.icon
            return (
              <li key={e.id}>
                <NavLink
                  to={e.path}
                  className={({ isActive }) => `nav__item${isActive ? ' is-active' : ''}`}
                  style={{ ['--item-accent' as string]: engineAccent(e, theme) }}
                  title={navOpen ? undefined : e.title}
                >
                  <Icon size={16} aria-hidden="true" />
                  {navOpen && <span className="nav__label">{e.name}</span>}
                  {navOpen && <span className="nav__stage mono">{e.stage}</span>}
                </NavLink>
              </li>
            )
          })}
        </ul>

        <NavLink
          to="/settings"
          className={({ isActive }) => `nav__item nav__settings${isActive ? ' is-active' : ''}`}
          title="Settings"
        >
          <SlidersHorizontal size={16} aria-hidden="true" />
          {navOpen && <span className="nav__label">Settings</span>}
        </NavLink>

        <button className="nav__collapse" onClick={() => setNavOpen((v) => !v)} title={navOpen ? 'Collapse' : 'Expand'}>
          {navOpen ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}
          {navOpen && <span>Collapse</span>}
        </button>
      </nav>

      {/* ── Top bar ─────────────────────────────────────────────────── */}
      <header className="topbar">
        <div className="topbar__where">
          <AgentMark state="idle" size={18} />
          <span className="topbar__engine">
            {engine?.title ?? (location.pathname === '/help' ? 'User Manual' : 'Command Centre')}
          </span>
          {engine && <span className="topbar__task mono">{engine.task}</span>}
        </div>

        <div className="topbar__right">
          {company && (
            <span className="topbar__company" title="The company every engine is currently scoped to">
              <Search size={12} aria-hidden="true" />
              {company.companyName ?? company.crmCompanyId}
            </span>
          )}
          <button
            className="topbar__icon"
            onClick={() => setContextOpen((v) => !v)}
            title={contextOpen ? 'Hide company context' : 'Show company context'}
            aria-pressed={contextOpen}
          >
            <PanelRightClose size={15} />
          </button>
          {principal && (
            <span className="topbar__user" title={`${principal.email} — role: ${principal.role}`}>
              <span className="topbar__avatar" aria-hidden="true">
                {principal.name?.slice(0, 1).toUpperCase() ?? '?'}
              </span>
              <span className="topbar__username">{principal.name}</span>
              <span className="topbar__role mono">{principal.role}</span>
            </span>
          )}
          {/* The User Manual: every step of the workflow, in plain words. */}
          <NavLink to="/help" className="topbar__icon" title="Help — User Manual" aria-label="Help">
            <HelpCircle size={15} aria-hidden="true" />
          </NavLink>
          <NavLink to="/settings" className="topbar__icon" title="Settings">
            <SlidersHorizontal size={15} />
          </NavLink>
          <ThemeSwitch />
          <button className="topbar__icon" onClick={signOut} title="Sign out">
            <LogOut size={15} />
          </button>
        </div>
      </header>

      {/* ── Centre: the active workspace ────────────────────────────── */}
      <main className="workspace" key={location.pathname}>
        <div className="route-enter">
          {/* Keyed on the path so leaving a broken engine clears its error. */}
          <RouteBoundary resetKey={location.pathname} what={engine?.title ?? 'This page'}>
            <Outlet />
          </RouteBoundary>
        </div>
      </main>

      {/* ── Right: shared company context ───────────────────────────── */}
      {contextOpen && <ContextPanel />}
    </div>
  )
}
