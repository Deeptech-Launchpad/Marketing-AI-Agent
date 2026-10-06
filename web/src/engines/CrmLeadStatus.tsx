import { createContext, useContext, useState } from 'react'
import { Upload, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { Button, Chip } from '../components/ui/primitives'
import { InfoTip } from '../components/ui/InfoTip'
import type { DiscoveredCompany } from '../lib/types'

// IS THIS COMPANY IN NXT SALES? (2026-09-29)
//
// Every company Prospects finds is checked against the live NXT Sales CRM
// (read only). One that is genuinely new can be added there — by a person, on
// a click and a confirmation — with Lead Source "Marketing AI Agent" and that
// person as its owner. The CRM decides what is a duplicate; a duplicate is
// linked, never created again.

export interface LeadWriteStatus {
  canWrite: boolean
  target: 'local' | 'live'
  sourceField: string | null
  sourceValue: string
  reason: string | null
}

export interface CrmLeadContextValue {
  status: LeadWriteStatus | null
  /** The person may add to NXT Sales (approve permission). */
  canAdd: boolean
  /** The person may re-run the NXT Sales check (operate permission). */
  canCheck?: boolean
  /** The automatic check is still expected to arrive (just after a search). */
  checking?: boolean
  onChanged: () => void
}

export const CrmLeadContext = createContext<CrmLeadContextValue>({ status: null, canAdd: false, onChanged: () => undefined })

const MATCHED_ON: Record<string, string> = {
  domain: 'same website',
  name: 'same company name',
  email: 'same email',
  crm_rule: 'NXT Sales duplicate rule',
  created: 'added from here',
}

const HELP = {
  title: 'NXT Sales',
  what: 'Every company found here is checked against the live NXT Sales CRM — by website, name and email. "In NXT Sales" means it already exists there; "New" means it does not. Adding a new one creates it in NXT Sales with Lead Source "Marketing AI Agent", owned by you.',
  next: 'Add genuinely new companies you want to work. Existing ones are never created twice.',
}

interface AddResult {
  outcome: 'created' | 'already_in_crm' | 'in_progress' | 'uncertain' | 'error'
  crmCompanyId?: string
  crmName?: string | null
  message?: string
}

export function CrmStatus({ company }: { company: DiscoveredCompany }) {
  const ctx = useContext(CrmLeadContext)
  const [busy, setBusy] = useState<null | 'add' | 'check'>(null)
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState<{ tone: 'ok' | 'danger' | 'info'; text: string } | null>(null)

  const linked = Boolean(company.crmCompanyId)
  const unchecked = !company.crmCheckedAt
  // Same name as an NXT Sales company with a different website: a person decides.
  const conflict = !linked && company.crmMatchedOn === 'name_conflict'
  const failed = !linked && !conflict && Boolean(company.crmCheckNote)

  const add = async () => {
    setBusy('add')
    setNote(null)
    try {
      const r = await api.post<{ results: AddResult[] }>('/crm-leads/companies/add', { ids: [company.id] })
      const res = r.results?.[0]
      if (res?.outcome === 'created') setNote({ tone: 'ok', text: 'Added to NXT Sales.' })
      else if (res?.outcome === 'already_in_crm') setNote({ tone: 'info', text: `Already in NXT Sales${res.crmName ? ` as "${res.crmName}"` : ''} — linked, not created again.` })
      else setNote({ tone: 'danger', text: res?.message ?? 'Not added.' })
      ctx.onChanged()
    } catch (err) {
      setNote({ tone: 'danger', text: (err as Error).message || 'Not added.' })
    } finally {
      setBusy(null)
      setConfirming(false)
    }
  }

  const check = async () => {
    setBusy('check')
    setNote(null)
    try {
      await api.post(`/crm-leads/companies/${encodeURIComponent(company.id)}/check`, {})
      ctx.onChanged()
    } catch (err) {
      setNote({ tone: 'danger', text: (err as Error).message || 'Could not check.' })
    } finally {
      setBusy(null)
    }
  }

  const addable = !linked && !unchecked && !failed && !conflict

  return (
    <span className="crmlead">
      {linked ? (
        <Chip tone="ok" title={company.crmCompanyId ?? undefined}>
          In NXT Sales{company.crmMatchedOn ? ` · ${MATCHED_ON[company.crmMatchedOn] ?? company.crmMatchedOn}` : ''}
        </Chip>
      ) : conflict ? (
        <Chip tone="warn" title={company.crmCheckNote ?? undefined}>
          Same name in NXT Sales — different website
        </Chip>
      ) : unchecked && ctx.checking !== false ? (
        <Chip tone="neutral">Checking NXT Sales…</Chip>
      ) : unchecked ? (
        // The automatic check runs once, right after a search. A company it
        // never reached — an older search, or a worker restart mid-check —
        // used to read "Checking NXT Sales…" for ever, with no way to check
        // it (2026-10-06).
        <Chip tone="neutral">Not checked against NXT Sales yet</Chip>
      ) : failed ? (
        <Chip tone="warn" title={company.crmCheckNote ?? undefined}>
          NXT Sales not checked
        </Chip>
      ) : (
        <Chip tone="info">New — not in NXT Sales</Chip>
      )}
      <InfoTip help={HELP} label="the NXT Sales check" />

      {ctx.canCheck !== false && (failed || (!linked && !(unchecked && ctx.checking !== false))) && (
        <Button size="sm" variant="quiet" icon={RefreshCw} busy={busy === 'check'} onClick={() => void check()}>
          Check again
        </Button>
      )}

      {addable && ctx.canAdd && ctx.status?.canWrite && !confirming && (
        <Button size="sm" icon={Upload} onClick={() => setConfirming(true)}>
          Add to NXT Sales
        </Button>
      )}
      {addable && ctx.canAdd && ctx.status?.canWrite && confirming && (
        <span className="crmlead__confirm">
          <span className="cell-dim">
            Create in {ctx.status.target === 'live' ? 'the live' : 'the local'} NXT Sales, owned by you, Lead Source “{ctx.status.sourceValue}”?
          </span>
          <Button size="sm" variant="primary" busy={busy === 'add'} onClick={() => void add()}>
            Confirm add
          </Button>
          <Button size="sm" variant="quiet" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
        </span>
      )}
      {addable && ctx.canAdd && ctx.status && !ctx.status.canWrite && (
        <span className="cell-dim" title={ctx.status.reason ?? undefined}>
          Adding to NXT Sales is off
        </span>
      )}

      {(failed || conflict) && company.crmCheckNote && <span className="crmlead__note cell-dim">{company.crmCheckNote}</span>}
      {note && (
        <span className={`crmlead__note ${note.tone === 'danger' ? 'otr-err' : 'cell-dim'}`} role="status">
          {note.text}
        </span>
      )}
    </span>
  )
}
