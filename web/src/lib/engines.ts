import {
  Radar,
  Layers,
  Activity,
  Users,
  Send,
  GitBranch,
  Cloud,
  type LucideIcon,
} from 'lucide-react'
import type { Theme } from './theme'

// ─────────────────────────────────────────────────────────────────────────
// The engines.
//
// One registry, read by the navigation, the command-centre pipeline, the
// engine headers and the accent system — so an engine's identity is declared
// once and cannot drift between the places it appears.
//
// `stage` is the pipeline position. Website Audit, Audit Report, Human
// Approval and AI Workbench were removed from the interface on 2026-09-24 —
// the product moved to Gemini-led prospecting, Intent Signals and Direct
// Outreach. Intent Score and Sales Qualification were removed the same day,
// because Engagement now presents Intent Source, Engagement and Qualification
// together. The stages were renumbered so the rail reads without a gap. Every
// removed screen is still in the repository, unmounted, and can be put back by
// restoring its registry entry and route.
// ─────────────────────────────────────────────────────────────────────────

export interface EngineDef {
  id: string
  /** Short label for the navigation rail. */
  name: string
  /** Full name for the workspace header. */
  title: string
  /** What this engine actually does, in the platform's own words. */
  purpose: string
  path: string
  icon: LucideIcon
  /** CSS custom property holding this engine's accent. */
  accentVar: string
  /**
   * Literal accents, for canvas drawing where CSS variables cannot reach.
   *
   * One hue per engine, one value per theme: the same identity, at the
   * lightness each ground can actually carry. `accent` is the approved dark
   * value; `accentLight` is its counterpart. Read them through
   * `engineAccent()` rather than directly, so nothing draws in the wrong one.
   */
  accent: string
  accentLight: string
  /** Which Kanboard task built the backend behind it. */
  task: string
  /** Position in the pipeline story, 1–7. */
  stage: number
}

export const ENGINES: EngineDef[] = [
  {
    id: 'prospect',
    name: 'Prospect',
    title: 'Prospect Discovery',
    purpose: 'Finds new companies on the public web that match a stated objective.',
    path: '/prospect',
    icon: Radar,
    accentVar: '--e-prospect',
    accent: '#a855f7',
    accentLight: '#6b21a8',
    task: '#977',
    stage: 1,
  },
  {
    id: 'enrichment',
    name: 'Enrichment',
    title: 'Company Enrichment',
    purpose: 'Detects the technology a company publishes, with evidence for each.',
    path: '/enrichment',
    icon: Layers,
    accentVar: '--e-enrichment',
    accent: '#3b82f6',
    accentLight: '#1e40af',
    task: '#977',
    stage: 2,
  },
  {
    id: 'intent',
    name: 'Intent',
    title: 'Intent Signals',
    purpose: 'Collects buying signals from public news, discussions, reviews and the CRM, with sources.',
    path: '/intent',
    icon: Activity,
    accentVar: '--e-intent',
    accent: '#22d3ee',
    accentLight: '#155e75',
    task: '#977',
    stage: 3,
  },
  {
    id: 'decision-makers',
    name: 'Decision Makers',
    title: 'Decision Maker Discovery',
    purpose: 'Identifies who owns product data, and never guesses a contact detail.',
    path: '/decision-makers',
    icon: Users,
    accentVar: '--e-decisionmaker',
    accent: '#f59e0b',
    accentLight: '#7c2d12',
    task: '#978',
    stage: 4,
  },
  {
    id: 'outreach',
    name: 'Outreach',
    title: 'Multichannel Outreach',
    purpose: 'Prepares the approved email sequence. A person approves and sends every email.',
    path: '/outreach',
    icon: Send,
    accentVar: '--e-outreach',
    accent: '#f97316',
    accentLight: '#9a3412',
    task: '#982',
    stage: 5,
  },
  {
    id: 'engagement',
    name: 'Engagement',
    title: 'Engagement Tracking',
    purpose: 'Records what the prospect actually did, separately from what we did.',
    path: '/engagement',
    icon: GitBranch,
    accentVar: '--e-engagement',
    accent: '#6366f1',
    accentLight: '#3730a3',
    task: '#983',
    stage: 6,
  },
]

/**
 * Workspaces reached from Settings rather than from the engine rail.
 *
 * CRM Sync is a handoff to another system, not a stage a company moves
 * through, so it sits under Settings (2026-09-24) and is not a pipeline node.
 * `stage` is 0: it has no place in the pipeline's numbering.
 */
export const SETTINGS_TOOLS: EngineDef[] = [
  {
    id: 'crm',
    name: 'CRM Sync',
    title: 'CRM / NXT Sales',
    purpose: 'Prepares a verified handoff package for the CRM.',
    path: '/settings/crm-sync',
    icon: Cloud,
    accentVar: '--e-crm',
    accent: '#14b8a6',
    accentLight: '#115e59',
    task: '#986',
    stage: 0,
  },
]

/** Every workspace with an engine header — the rail's engines and the Settings tools. */
const ALL_WORKSPACES: EngineDef[] = [...ENGINES, ...SETTINGS_TOOLS]

export const ENGINE_BY_ID = new Map(ALL_WORKSPACES.map((e) => [e.id, e]))

/** The literal accent an engine draws with under the given theme. */
export function engineAccent(engine: EngineDef, theme: Theme): string {
  return theme === 'light' ? engine.accentLight : engine.accent
}

/** The same, for the brand accent used away from any single engine. */
export function brandAccent(theme: Theme): string {
  return theme === 'light' ? '#136184' : '#29abe2'
}

export function engineForPath(pathname: string): EngineDef | undefined {
  return ALL_WORKSPACES.find((e) => pathname === e.path || pathname.startsWith(`${e.path}/`))
}

/** The pipeline nodes, in flow order, for the command centre. */
export const PIPELINE: EngineDef[] = [
  'prospect',
  'enrichment',
  'intent',
  'decision-makers',
  'outreach',
  'engagement',
].map((id) => ENGINE_BY_ID.get(id)!)

/** Converts a hex accent to an "r, g, b" triple for rgba() composition. */
export function rgbTriple(hex: string): string {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve']

/** A count in words ("nine"), for copy that names how many engines there are. */
export function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n)
}
