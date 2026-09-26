import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Building2, ChevronDown, Search } from 'lucide-react'
import { api } from '../../lib/api'
import { useAsync } from '../../lib/hooks'
import { useCompany } from '../../lib/companyContext'
import type { CompanySearch, EngagementEvent } from '../../lib/types'
import { technologySummary } from '../../lib/enrichmentSummary'
import { Unset } from '../ui/primitives'
import './shell.css'

/** "workbench_demo_opened" as a person would say it. */
function humanEvent(eventType: string): string {
  const words = eventType.replace(/[._-]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ─────────────────────────────────────────────────────────────────────────
// The shared company context.
//
// One company, followed across all twelve engines. Everything shown here is
// read from the engines that produced it — the score from #984, the
// qualification from #985, the engagement counts from #983. Nothing is
// derived in the browser, and a value the backend does not hold is shown as
// missing rather than filled in.
// ─────────────────────────────────────────────────────────────────────────

export function ContextPanel() {
  const { company, companies, select } = useCompany()
  const [picking, setPicking] = useState(false)
  const [term, setTerm] = useState('')
  // The typed word settles before the CRM is asked. A request per keystroke
  // would put avoidable load on the customer's CRM for answers nobody reads.
  const [settled, setSettled] = useState('')

  const id = company?.crmCompanyId

  useEffect(() => {
    const timer = setTimeout(() => setSettled(term.trim()), 250)
    return () => clearTimeout(timer)
  }, [term])

  // WHAT THE PICKER OFFERS, AND FROM WHERE.
  //
  // The register holds the companies this platform has worked on. That is not
  // the same question as "which companies does the customer have" — the CRM
  // answers that, and a company sitting in it could not be selected here until
  // some engine happened to touch it. So the typed word goes to both: the
  // register is filtered in the browser, and the CRM is asked as well.
  const found = useAsync<CompanySearch | null>(
    (signal) =>
      settled.length >= 2
        ? api.get<CompanySearch>(`/companies/search?q=${encodeURIComponent(settled)}&limit=20`, { signal })
        : Promise.resolve(null),
    [settled],
    { enabled: picking && settled.length >= 2 },
  )

  // Intent Score and Sales Qualification are not requested at all while their
  // presentation is locked. Fetching a value in order not to show it is a
  // request made for nothing, and it would leave the panel able to leak one
  // through a loading or error state.
  //
  // Engagement asks for the EVENTS rather than the summary. The summary is a
  // set of counts (events by us, events by the prospect, distinct sessions),
  // and a count was exactly what could not be defended: nothing on the panel
  // said what one unit of it was, which events were inside it, or over what
  // period. An act has a name, a channel, a time and a source, and every one
  // of those can be checked.
  const activity = useAsync<{ events: EngagementEvent[] } | null>(
    (signal) =>
      id
        ? api.get<{ events: EngagementEvent[] }>(`/engagement/companies/${id}/timeline?limit=3`, {
            signal,
            nullOn404: true,
          })
        : Promise.resolve(null),
    [id],
    { enabled: Boolean(id) },
  )

  // The selected company as the register knows it NOW. `company` is the
  // reference captured at selection time (and restored from storage), so on
  // its own it froze whatever was known then — "Website: Not recorded" beside a
  // company enrichment had since read. The merged entry in `companies` is kept
  // current by the register, so it wins; `company` is the fallback.
  const current = useMemo(
    () => (id ? companies.find((c) => c.crmCompanyId === id) ?? null : null),
    [companies, id],
  )
  const website = current?.sourceUrl || company?.sourceUrl || current?.website || company?.website || null
  const status = current?.enrichmentStatus ?? company?.enrichmentStatus ?? null
  const technologies = current?.technologies ?? company?.technologies
  const techText = technologySummary({ status, technologies: (technologies ?? []).map((name) => ({ name })) })
  const techNames = status === 'enriched' ? technologies ?? [] : []

  const sorted = useMemo(
    () => [...companies].sort((a, b) => (a.companyName ?? '').localeCompare(b.companyName ?? '')),
    [companies],
  )

  const needle = term.trim().toLowerCase()
  const known = useMemo(
    () => (needle ? sorted.filter((c) => (c.companyName ?? c.crmCompanyId).toLowerCase().includes(needle)) : sorted),
    [sorted, needle],
  )
  // A company already on the list above is not repeated below.
  const fromCrm = useMemo(() => {
    const have = new Set(known.map((c) => c.crmCompanyId))
    return (found.data?.companies ?? []).filter((c) => !have.has(c.crmCompanyId))
  }, [found.data, known])

  return (
    <aside className="context" aria-label="Company context">
      <header className="context__head">
        <p className="eyebrow">Shared context</p>
        <button className="context__picker" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          <span className="context__avatar" aria-hidden="true">
            {(company?.companyName ?? '?').slice(0, 2).toUpperCase()}
          </span>
          <span className="context__name">{company?.companyName ?? 'Select a company'}</span>
          <ChevronDown size={14} aria-hidden="true" />
        </button>

        {picking && (
          <div className="context__menu" role="listbox">
            <div className="context__search">
              <Search size={13} aria-hidden="true" />
              <input
                autoFocus
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                placeholder="Company or industry…"
                aria-label="Search companies in the CRM"
              />
            </div>

            {known.length === 0 && !needle && (
              <p className="context__menu-empty">
                No company has been through the pipeline yet. Run enrichment to add one, or search the CRM above.
              </p>
            )}

            {known.map((c) => (
              <button
                key={c.crmCompanyId}
                role="option"
                aria-selected={c.crmCompanyId === id}
                className={`context__menu-item${c.crmCompanyId === id ? ' is-active' : ''}`}
                onClick={() => {
                  select(c)
                  setPicking(false)
                }}
              >
                <span>{c.companyName ?? c.crmCompanyId}</span>
                {c.enrichmentStatus === 'enriched' && c.technologies?.length ? (
                  <span className="mono context__menu-meta">{c.technologies[0]}{c.technologies.length > 1 ? ` +${c.technologies.length - 1}` : ''}</span>
                ) : null}
              </button>
            ))}

            {/* THE CRM'S OWN ANSWER, kept apart from the platform's own list so
                nobody has to wonder which is which. */}
            {needle.length >= 2 && (
              <>
                <p className="context__menu-head">In NXT Sales</p>
                {found.loading && <p className="context__menu-empty">Searching the CRM…</p>}
                {found.error && (
                  <p className="context__menu-empty">The CRM could not be searched: {found.error.message}</p>
                )}
                {!found.loading && !found.error && fromCrm.length === 0 && (
                  <p className="context__menu-empty">{found.data?.note ?? 'No company in the CRM matched this.'}</p>
                )}
                {fromCrm.map((c) => (
                  <button
                    key={c.crmCompanyId}
                    role="option"
                    aria-selected={c.crmCompanyId === id}
                    className="context__menu-item"
                    onClick={() => {
                      // Selected straight from the CRM record: the name, the
                      // site and the industry as NXT Sales holds them, and
                      // nothing filled in that it does not.
                      select({
                        crmCompanyId: c.crmCompanyId,
                        companyName: c.companyName,
                        sourceUrl: c.website,
                        website: c.website,
                        industry: c.industry,
                        location: c.country,
                      })
                      setPicking(false)
                      setTerm('')
                    }}
                  >
                    <span>{c.companyName}</span>
                    <span className="mono context__menu-meta">
                      {c.matchedOn === 'industry' ? (c.industry ?? 'industry') : (c.country ?? c.industry ?? '')}
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        )}
      </header>

      {!company ? (
        <div className="context__blank">
          <Building2 size={20} aria-hidden="true" />
          <p>Select a company to carry its context across every engine.</p>
        </div>
      ) : (
        <div className="context__body">
          <section className="context__block">
            <p className="eyebrow">Account</p>
            <dl className="context__dl">
              <dt>Company</dt>
              <dd>{company.companyName ?? <Unset />}</dd>
              <dt>Website</dt>
              <dd>
                {website ? (
                  <a href={/^https?:\/\//i.test(website) ? website : `https://${website}`} target="_blank" rel="noopener noreferrer">
                    {website.replace(/^https?:\/\//, '').slice(0, 30)}
                  </a>
                ) : (
                  <Unset />
                )}
              </dd>
              <dt>Technologies</dt>
              {/* Names, not a count, and an empty state that says WHY it is
                  empty: never enriched, unreachable, or read with nothing
                  matched are three different facts. */}
              <dd title={techNames.length ? techNames.join(', ') : undefined}>
                {techNames.length ? techText : <Unset what={techText} />}
              </dd>
              <dt>CRM id</dt>
              <dd className="mono context__id">{company.crmCompanyId}</dd>
            </dl>
          </section>

          {/* Engagement, as acts rather than as arithmetic.
              Four counters stood here: events by the prospect, events by us,
              distinct sessions, and a freshness word. None of them answered
              "what happened, when, and how would I check it?" - and a
              three-digit total beside a company name reads as interest whether
              or not anyone can say what a single unit of it was. These are the
              last acts themselves. */}
          <section className="context__block">
            <p className="eyebrow">Recent activity</p>
            {activity.loading ? (
              <div className="skeleton context__skel" />
            ) : activity.data?.events?.length ? (
              <ul className="context__acts">
                {activity.data.events.slice(0, 3).map((e) => (
                  <li key={e.id} className="context__act">
                    <span className="context__act-what">{humanEvent(e.eventType)}</span>
                    <span className="context__act-meta">
                      {e.channel} · {new Date(e.occurredAt).toLocaleDateString()}
                    </span>
                    <span className="context__act-src">{e.sourceProvider ?? e.source}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="context__none">No prospect engagement observed yet.</p>
            )}
          </section>

          <Link to="/engagement" className="context__link">
            Open engagement timeline →
          </Link>
        </div>
      )}
    </aside>
  )
}

