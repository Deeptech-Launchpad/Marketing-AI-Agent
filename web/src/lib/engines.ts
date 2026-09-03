import {
  Radar,
  Layers,
  Activity,
  Users,
  ScanLine,
  FileText,
  ShieldCheck,
  Wrench,
  Send,
  GitBranch,
  Gauge,
  Target,
  Cloud,
  type LucideIcon,
} from 'lucide-react'
import type { Theme } from './theme'

// ─────────────────────────────────────────────────────────────────────────
// The twelve engines.
//
// One registry, read by the navigation, the command-centre pipeline, the
// engine headers and the accent system — so an engine's identity is declared
// once and cannot drift between the places it appears.
//
// `stage` is the pipeline position from the platform brief. Website Audit and
// Audit Report are two workspaces over one pipeline stage (an audit and the
// report drawn from it), and Qualification and CRM are two views of the final
// handoff, which is why thirteen workspaces sit on twelve pipeline nodes.
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
  /** Position in the pipeline story, 1–12. */
  stage: number
}

export const ENGINES: EngineDef[] = [
  {
    id: 'prospect',
    name: 'Prospect',
    title: 'Prospect Discovery',
    purpose: 'Finds companies in NXT Sales that match a stated objective.',
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
    purpose: 'Collects buying signals from the CRM, careers pages and job boards.',
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
    id: 'audit',
    name: 'Website Audit',
    title: 'Website Audit',
    purpose: 'Crawls a bounded sample of pages and records only what it observed.',
    path: '/audit',
    icon: ScanLine,
    accentVar: '--e-audit',
    accent: '#22c55e',
    accentLight: '#166534',
    task: '#979',
    stage: 5,
  },
  {
    id: 'report',
    name: 'Audit Report',
    title: 'Audit Report',
    purpose: 'Turns observations into sample-scoped findings and a client-ready PDF.',
    path: '/report',
    icon: FileText,
    accentVar: '--e-report',
    accent: '#10b981',
    accentLight: '#065f46',
    task: '#979',
    stage: 5,
  },
  {
    id: 'approval',
    name: 'Approval',
    title: 'Human Approval',
    purpose: 'A named reviewer approves a report before anything customer-facing is built.',
    path: '/approval',
    icon: ShieldCheck,
    accentVar: '--e-approval',
    accent: '#eab308',
    accentLight: '#854d0e',
    task: '#980',
    stage: 6,
  },
  {
    id: 'workbench',
    name: 'Workbench',
    title: 'AI Workbench',
    purpose: 'Builds a before/after demonstration from the prospect’s own evidence.',
    path: '/workbench',
    icon: Wrench,
    accentVar: '--e-workbench',
    accent: '#ec4899',
    accentLight: '#9d174d',
    task: '#981',
    stage: 7,
  },
  {
    id: 'outreach',
    name: 'Outreach',
    title: 'Multichannel Outreach',
    purpose: 'Composes and schedules a sequence. A person releases every send.',
    path: '/outreach',
    icon: Send,
    accentVar: '--e-outreach',
    accent: '#f97316',
    accentLight: '#9a3412',
    task: '#982',
    stage: 8,
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
    stage: 9,
  },
  {
    id: 'scoring',
    name: 'Intent Score',
    title: 'Intent Scoring',
    purpose: 'Turns observed engagement into an explainable score. Every point cites an event.',
    path: '/scoring',
    icon: Gauge,
    accentVar: '--e-scoring',
    accent: '#06b6d4',
    accentLight: '#164e63',
    task: '#984',
    stage: 10,
  },
  {
    id: 'qualification',
    name: 'Qualification',
    title: 'Sales Qualification',
    purpose: 'Compares the score to a business threshold and hands the lead to a person.',
    path: '/qualification',
    icon: Target,
    accentVar: '--e-qualification',
    accent: '#fbbf24',
    accentLight: '#92400e',
    task: '#985',
    stage: 11,
  },
  {
    id: 'crm',
    name: 'CRM Sync',
    title: 'CRM / NXT Sales',
    purpose: 'Prepares a verified handoff package for the CRM.',
    path: '/crm',
    icon: Cloud,
    accentVar: '--e-crm',
    accent: '#14b8a6',
    accentLight: '#115e59',
    task: '#986',
    stage: 12,
  },
]

export const ENGINE_BY_ID = new Map(ENGINES.map((e) => [e.id, e]))

/** The literal accent an engine draws with under the given theme. */
export function engineAccent(engine: EngineDef, theme: Theme): string {
  return theme === 'light' ? engine.accentLight : engine.accent
}

/** The same, for the brand accent used away from any single engine. */
export function brandAccent(theme: Theme): string {
  return theme === 'light' ? '#136184' : '#29abe2'
}

export function engineForPath(pathname: string): EngineDef | undefined {
  return ENGINES.find((e) => pathname === e.path || pathname.startsWith(`${e.path}/`))
}

/** The twelve pipeline nodes, in flow order, for the command centre. */
export const PIPELINE: EngineDef[] = [
  'prospect',
  'enrichment',
  'intent',
  'decision-makers',
  'audit',
  'approval',
  'workbench',
  'outreach',
  'engagement',
  'scoring',
  'qualification',
  'crm',
].map((id) => ENGINE_BY_ID.get(id)!)

/** Converts a hex accent to an "r, g, b" triple for rgba() composition. */
export function rgbTriple(hex: string): string {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}
