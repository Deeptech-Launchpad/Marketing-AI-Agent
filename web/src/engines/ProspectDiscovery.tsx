import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { useAsync, useEngineAction, usePolling } from '../lib/hooks'
import { useEngine, EnginePage, EngineSplit, type EngineCompletion } from '../components/shell/EnginePage'
import { useAuth } from '../lib/auth'
import { useCompany, type CompanyRef } from '../lib/companyContext'
import { ArrowRight, Building2, ChevronDown, ExternalLink, Globe, History, MapPin, Search, Trash2 } from 'lucide-react'
import { Panel, Metric, MetricRow, Chip, Button, Field, StatusBadge, toUiStatus, Unset } from '../components/ui/primitives'
import { EmptyState, ErrorState, LoadingState } from '../components/ui/states'
import { RadarSweep } from '../components/motion/Signatures'
import type { CompanyDiscoverySearch, DiscoveredCompany, ServiceNeed } from '../lib/types'
import { ProductPageView } from './ProductPageView'
import { IDENTITY_LABEL, useCompanyIdentity, type CompanyIdentity } from '../lib/companyIdentity'
import './prospect.css'

// Prospect Discovery (#977).
//
// A company enters the pipeline in one of two ways, and the screen keeps them
// visibly apart:
//
//   SELECTED COMPANY — a company already chosen in Shared context. It exists
//   in NXT Sales; nothing needs to be found. The pipeline starts at Enrichment
//   and no discovery run is created for it.
//
//   FIND NEW COMPANIES — a stated objective is searched on the PUBLIC WEB, and
//   every company it names is verified by reading that company's own website.
//   Nothing is invented: a company is listed only because a real page was
//   found, and a page that could not be read is listed apart, unassessed,
//   rather than dropped.
//
// (2026-09-25) A found company is only a prospect because of its own product
// page. Each one's website is opened, one real product page on it is audited
// the way a PDP audit reads one, and the results are grouped by whether that
// page shows a need for the service — never by the search result alone.
//
// (2026-09-24) The earlier CRM search — its objective form, count picker, run
// history and per-run result card — was removed from this screen at the
// product owner's request. The CRM endpoints still exist; this screen no
// longer draws them.

// The source a selected company is shown with — "NXT Sales company" or
// "Found by Prospects" — comes from a live check (lib/companyIdentity.ts),
// never from where it was picked: a Prospects find was being labelled an
// NXT Sales record with a CRM id that was really this platform's own id.

/** How a company is entering the pipeline from this screen. */
type Mode = 'company' | 'discover'

/** Companies per page, in every list on this screen. */
const PAGE_SIZE = 10

/**
 * Strongest opportunity first: "needed" before "possible", then the most
 * serious gaps, then the most gaps. Sales reads down the list.
 */
function opportunityRank(c: DiscoveredCompany): number[] {
  const gaps = c.productAnalysis?.gaps ?? []
  return [
    c.serviceNeed === 'needed' ? 0 : 1,
    -gaps.filter((g) => g.severity === 'major').length,
    -gaps.filter((g) => g.severity === 'gap').length,
  ]
}

function byRank(a: DiscoveredCompany, b: DiscoveredCompany): number {
  const ra = opportunityRank(a)
  const rb = opportunityRank(b)
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! - rb[i]!
  return displayName(a).localeCompare(displayName(b))
}

/**
 * The opportunities, strongest first. Only these get a full card: a company
 * whose product is already presented completely is not a prospect, and is
 * listed in one line with the reason rather than pitched.
 */
const OPPORTUNITY_GROUPS: Array<{ key: Extract<ServiceNeed, 'needed' | 'possible'>; title: string; hint: string }> = [
  { key: 'needed', title: 'Our service is needed', hint: 'The one product checked is missing core product information.' },
  { key: 'possible', title: 'Possible opportunity', hint: 'The one product checked has one clear gap in its information.' },
]

const NEED_LABEL: Record<Extract<ServiceNeed, 'needed' | 'possible'>, string> = {
  needed: 'Service needed',
  possible: 'Possible opportunity',
}

const isAnalysed = (c: DiscoveredCompany): boolean =>
  c.productAnalysis?.status === 'analysed' && c.serviceNeed != null && c.serviceNeed !== 'not_assessed'

export function ProspectDiscovery() {
  const engine = useEngine('prospect')
  const { can } = useAuth()
  const { company, select } = useCompany()
  const navigate = useNavigate()

  // A company already selected in Shared context opens the screen on itself:
  // that is the case where nothing needs to be found. The choice is the
  // operator's from then on. Without a company there is only one mode.
  const [chosenMode, setChosenMode] = useState<Mode>(() => (company ? 'company' : 'discover'))
  const mode: Mode = company ? chosenMode : 'discover'
  // Whether the selected company is an NXT Sales record or a Prospects find,
  // checked live — never assumed from where it was picked.
  const { identity } = useCompanyIdentity(mode === 'company' ? company?.crmCompanyId : null)

  const [webObjective, setWebObjective] = useState('')
  const [webSearchId, setWebSearchId] = useState<string | null>(null)

  const webSearches = useAsync<{ searches: CompanyDiscoverySearch[] }>(
    (signal) => api.get('/company-discovery/searches', { signal }),
    [],
  )
  const webRows = webSearches.data?.searches ?? []
  // Newest first from the API, so the head of the list is the search just made.
  const webSearchIdResolved = webSearchId ?? webRows[0]?.id ?? null
  const webSearch = webRows.find((s) => s.id === webSearchIdResolved) ?? null

  const webCompanies = useAsync<{ status: string; companies: DiscoveredCompany[] } | null>(
    (signal) =>
      webSearchIdResolved
        ? api.get(`/company-discovery/searches/${webSearchIdResolved}/companies`, { signal })
        : Promise.resolve(null),
    [webSearchIdResolved],
    { enabled: Boolean(webSearchIdResolved) },
  )
  const candidates = webCompanies.data?.companies ?? []

  const live = webSearch?.status === 'queued' || webSearch?.status === 'running'
  usePolling(() => {
    webSearches.refresh()
    webCompanies.refresh()
  }, live)

  const discoverWeb = useEngineAction(async () => {
    const text = webObjective.trim()
    if (!text) return
    const created = await api.post<{ id: string; status: string }>('/company-discovery/searches', { objective: text })
    setWebSearchId(created.id)
    webSearches.refresh()
  })

  /** Picks up a discovered company: its own id stands in for crmCompanyId. */
  const selectDiscovered = (c: DiscoveredCompany) => {
    select({
      crmCompanyId: c.crmCompanyId ?? c.id,
      companyName: displayName(c),
      sourceUrl: c.websiteUrl,
      website: c.websiteUrl,
      sourceProvider: 'company_web_discovery',
    })
    setChosenMode('company')
  }

  /**
   * Starts the pipeline for the company already in Shared context.
   *
   * Re-selecting the same reference is deliberate: it re-persists the choice
   * and promotes it in the picker, so the company Enrichment opens on is the
   * one this screen showed. Nothing else happens.
   */
  const startPipeline = () => {
    if (!company) return
    select(company)
    navigate('/enrichment')
  }

  const action =
    can('operate') && mode === 'company' && company ? (
      <Button icon={ArrowRight} variant="primary" onClick={startPipeline}>
        Start pipeline for this company
      </Button>
    ) : undefined

  const analysed = candidates.filter(isAnalysed)
  const needing = analysed.filter((c) => c.serviceNeed === 'needed' || c.serviceNeed === 'possible').sort(byRank)
  const noNeed = analysed.filter((c) => c.serviceNeed === 'not_needed')
  const statusOf = (c: DiscoveredCompany) => c.productAnalysis?.status
  const toReview = candidates.filter((c) => !isAnalysed(c) && (statusOf(c) === 'blocked' || statusOf(c) === 'browser_only'))
  const noProductPage = candidates.filter((c) => !isAnalysed(c) && statusOf(c) === 'no_product_page')
  const notChecked = candidates.filter(
    (c) => !isAnalysed(c) && !['no_product_page', 'blocked', 'browser_only'].includes(statusOf(c) ?? ''),
  )

  const completion = footerFor({
    mode,
    company,
    sourceLabel: identity ? IDENTITY_LABEL[identity.kind] : 'checking NXT Sales',
    status: webSearch?.status ?? null,
    found: candidates.length,
    needing: needing.length,
  })

  // The header mark says what is actually happening. A queued search is
  // waiting, not working: 'running' would spin for a search behind a worker
  // that is down.
  const mark =
    webSearch?.status === 'running' || discoverWeb.running
      ? 'running'
      : webSearch?.status === 'queued'
        ? 'thinking'
        : (mode === 'company' && company) || candidates.length
          ? 'success'
          : 'idle'

  return (
    <EnginePage
      engineId="prospect"
      state={mark}
      signature={<RadarSweep accent={engine.accent} />}
      actions={action}
      completion={completion}
    >
      <EngineSplit
        main={
          <>
            {/* ── How the company enters ───────────────────────────────────
                Two doors, side by side, one open. The company name on the
                first is there so a person can tell which door they are
                standing in without reading the panel below it. */}
            <div className="mode" role="tablist" aria-label="How a company enters the pipeline">
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'company'}
                className={`mode__tab${mode === 'company' ? ' is-active' : ''}`}
                onClick={() => setChosenMode('company')}
                disabled={!company}
                title={company ? undefined : 'Select a company in Shared context first.'}
                style={{ ['--e' as string]: engine.accent }}
              >
                <Building2 size={14} aria-hidden="true" />
                <span className="mode__text">
                  <span className="mode__title">Selected company</span>
                  <span className="mode__meta">{company ? (company.companyName ?? company.crmCompanyId) : 'None selected'}</span>
                </span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === 'discover'}
                className={`mode__tab${mode === 'discover' ? ' is-active' : ''}`}
                onClick={() => setChosenMode('discover')}
                style={{ ['--e' as string]: engine.accent }}
              >
                <Globe size={14} aria-hidden="true" />
                <span className="mode__text">
                  <span className="mode__title">Find new companies</span>
                  <span className="mode__meta">Public web search</span>
                </span>
              </button>
            </div>

            {mode === 'company' && company ? (
              <SelectedCompany
                company={company}
                identity={identity}
                accent={engine.accent}
                onStart={can('operate') ? startPipeline : undefined}
                onDiscoverInstead={() => setChosenMode('discover')}
              />
            ) : (
              <>
                {/* ── The question ─────────────────────────────────────── */}
                <Panel
                  title="Find New Company"
                  subtitle="Search the public web for companies that may not be in NXT Sales yet"
                  actions={
                    can('operate') && (
                      <Button
                        icon={Search}
                        variant="primary"
                        onClick={discoverWeb.fire}
                        busy={discoverWeb.running}
                        disabled={webObjective.trim().length < 2}
                      >
                        Search the public web
                      </Button>
                    )
                  }
                >
                  {webRows.length > 0 && (
                    <RecentSearches
                      searches={webRows}
                      currentId={webSearchIdResolved}
                      canDelete={can('operate')}
                      onPick={(id) => setWebSearchId(id)}
                      onDeleted={(id) => {
                        if (id === webSearchIdResolved) setWebSearchId(null)
                        webSearches.refresh()
                      }}
                    />
                  )}

                  <label className="field-label" htmlFor="web-discovery-objective">
                    Describe the companies you're looking for{' '}
                    <span className="field-hint">e.g. "Safety and Health companies in the USA"</span>
                  </label>
                  <textarea
                    id="web-discovery-objective"
                    className="textarea"
                    value={webObjective}
                    onChange={(e) => setWebObjective(e.target.value)}
                    rows={2}
                    placeholder="Safety and Health companies in the USA"
                  />
                  <p className="note" style={{ marginTop: 'var(--s3)' }}>
                    Gemini searches the public web for matching companies. For each one, its own website is opened and
                    one genuine individual product is picked — never a category, product-family, solution, article or FAQ
                    page. That one product’s description, attributes, values and structure are analysed, and the company is
                    shown as an opportunity only when that product’s information has a real gap our service fills. This is
                    not a website audit, and nothing is invented.
                  </p>
                  {discoverWeb.error && (
                    <p className="note note--caveat" style={{ marginTop: 'var(--s3)' }}>
                      {discoverWeb.error.message}
                    </p>
                  )}
                </Panel>

                {/* ── What it found ────────────────────────────────────── */}
                {webSearch && (
                  <Panel
                    title="Results"
                    subtitle={`“${webSearch.objective}”`}
                    actions={
                      <StatusBadge
                        status={toUiStatus(webSearch.status)}
                        label={webSearch.status.replace(/_/g, ' ')}
                        size="sm"
                      />
                    }
                  >
                    {live && (
                      <LoadingState
                        what={`Searching the public web and checking one product on each company’s website — ${webSearch.totalAssessed ?? 0} website(s) checked so far`}
                        rows={candidates.length ? 1 : 3}
                      />
                    )}
                    {webSearch.status === 'failed' ? (
                      <ErrorState
                        what="This search did not finish"
                        error={new Error(webSearch.failureReason ?? 'The search failed without giving a reason.')}
                      />
                    ) : webCompanies.loading && !webCompanies.data ? (
                      live ? null : <LoadingState what="Reading the results" rows={3} />
                    ) : candidates.length === 0 ? (
                      live ? null : (
                        <EmptyState
                          title="No company found"
                          detail="The search ran and found nothing checkable. That is a real result, not a failure — nothing was invented to fill the list."
                        />
                      )
                    ) : (
                      <div className="found">
                        <p className="found__summary-line">
                          <strong>{candidates.length}</strong> {candidates.length === 1 ? 'company' : 'companies'} found
                          {' · '}
                          <strong>{analysed.length}</strong> {analysed.length === 1 ? 'product' : 'products'} analysed, one
                          per company
                          {' · '}
                          <strong>{needing.length}</strong> {needing.length === 1 ? 'opportunity' : 'opportunities'}
                        </p>

                        {OPPORTUNITY_GROUPS.map((g) => (
                          <OpportunityGroup
                            key={`${webSearchIdResolved}:${g.key}`}
                            title={g.title}
                            hint={g.hint}
                            tone={g.key === 'needed' ? 'ok' : 'warn'}
                            rows={needing.filter((c) => c.serviceNeed === g.key)}
                            onSelect={can('operate') ? selectDiscovered : undefined}
                          />
                        ))}

                        <CompactGroup
                          title="Review manually"
                          hint="A product page exists, but the website blocks automated reading or builds the page in the browser. Open the product link to judge it yourself."
                          rows={toReview}
                          reasonOf={notAnalysedReason}
                          linkOf={(c) => c.productAnalysis?.reviewUrl ?? c.websiteUrl ?? c.discoverySourceUrl}
                          onSelect={can('operate') ? selectDiscovered : undefined}
                        />
                        <CompactGroup
                          title="No clear need"
                          hint="The product checked already presents its information completely, in the company’s own style."
                          rows={noNeed}
                          reasonOf={(c) => c.productAnalysis?.whyNeeded ?? ''}
                          linkOf={(c) => c.productAnalysis?.product?.url ?? c.websiteUrl ?? c.discoverySourceUrl}
                          onSelect={can('operate') ? selectDiscovered : undefined}
                        />
                        <CompactGroup
                          title="No genuine product page"
                          hint="The website was opened, but no single individual product could be found on it."
                          rows={noProductPage}
                          reasonOf={notAnalysedReason}
                          linkOf={(c) => c.websiteUrl ?? c.discoverySourceUrl}
                          onSelect={can('operate') ? selectDiscovered : undefined}
                        />
                        <CompactGroup
                          title="Could not be checked"
                          hint="Found by the search, but no company website could be checked — each with the reason."
                          rows={notChecked}
                          reasonOf={notAnalysedReason}
                          linkOf={(c) => c.websiteUrl ?? c.discoverySourceUrl}
                          onSelect={can('operate') ? selectDiscovered : undefined}
                        />
                      </div>
                    )}
                  </Panel>
                )}
              </>
            )}
          </>
        }
        side={
          mode === 'company' && company ? (
            <Panel title="Pipeline entry">
              {/* What is true about this company on this screen, and what is
                  not: no search, no provider, no result. Spelled out because
                  the sidebar's "Shared context" and this engine's discovered
                  company used to be indistinguishable one screen later. */}
              <Field label="Entry" value={identity?.kind === 'discovered' ? 'Selected from Prospects results' : 'Selected in Shared context'} />
              <Field label="Company" value={company.companyName ?? <Unset />} />
              <Field label="Source" value={identity ? IDENTITY_LABEL[identity.kind] : <Unset what="Checking NXT Sales…" />} />
              <Field
                label="Discovery"
                value={
                  identity?.kind === 'discovered' ? (
                    <StatusBadge status="complete" label="FOUND BY SEARCH" size="sm" />
                  ) : (
                    <StatusBadge status="idle" label="NOT RUN" size="sm" />
                  )
                }
              />
              <Field label="Next stage" value="Enrichment" />
              <p className="note" style={{ marginTop: 'var(--s4)' }}>
                {identity?.kind === 'discovered'
                  ? 'This company came from a Prospects search of the public web. It is not an NXT Sales record, and nothing has been written to the CRM.'
                  : 'Selecting is not discovering. No search row is created for this company, no provider is asked about it, and nothing later in the pipeline will say it was found here.'}
              </p>
            </Panel>
          ) : (
            <>
              <Panel title="Search detail">
                {!webSearch ? (
                  <div className="stack">
                    <StatusBadge status="idle" label="NOT RUN" size="sm" />
                    <Unset what="No search yet" />
                  </div>
                ) : (
                  <>
                    <div className="row" style={{ marginBottom: 'var(--s3)' }}>
                      <StatusBadge
                        status={toUiStatus(webSearch.status)}
                        label={webSearch.status.replace(/_/g, ' ')}
                        size="sm"
                      />
                    </div>
                    {webSearch.status === 'completed' ? (
                      <MetricRow>
                        <Metric label="Found" value={webSearch.totalCandidatesFound} size="sm" />
                        <Metric label="Checked" value={webSearch.totalAssessed} size="sm" />
                        <Metric label="Qualified" value={needing.length} size="sm" />
                      </MetricRow>
                    ) : (
                      <p className="note">No counts yet — the search has not finished, so there is nothing to tally.</p>
                    )}
                    <p className="eyebrow" style={{ marginTop: 'var(--s4)' }}>Objective as stated</p>
                    <p className="note" style={{ marginTop: 'var(--s2)' }}>{webSearch.objective}</p>
                    <p className="note" style={{ marginTop: 'var(--s3)' }}>
                      Each verdict is a read of one genuine product on that company’s own website — not an audit of the
                      whole website or catalogue.
                    </p>
                  </>
                )}
              </Panel>

            </>
          )
        }
      />
    </EnginePage>
  )
}

/**
 * One prospect: the company, the product page that was audited, and what that
 * page showed.
 *
 * Everything on it was read off the company's own product page, or is the
 * Website Audit's standard fix for a check that page failed — so each claim is
 * one click from its source.
 */
function ProspectCard({ company, onSelect }: { company: DiscoveredCompany; onSelect?: () => void }) {
  const a = company.productAnalysis!
  const product = a.product!
  const site = a.websiteUrl ?? company.websiteUrl ?? company.discoverySourceUrl
  // Rows from before the one-product change carry plain issue strings only.
  const gaps = a.gaps ?? a.issues.map((issue) => ({ key: issue, severity: 'gap' as const, title: issue, detail: '' }))
  const shown = gaps.filter((g) => g.severity !== 'minor')
  const minor = gaps.filter((g) => g.severity === 'minor')

  return (
    <article className="found__card found__card--prospect">
      <header className="found__cardhead">
        <h4 className="found__name">
          {displayName(company)}
        </h4>
        <a className="found__site" href={websiteUrl(site)} target="_blank" rel="noopener noreferrer">
          {company.domain ?? hostOf(site) ?? site}
          <ExternalLink size={11} aria-hidden="true" />
        </a>
        <span className={`found__need found__need--${company.serviceNeed}`}>
          {NEED_LABEL[company.serviceNeed === 'needed' ? 'needed' : 'possible']}
        </span>
        <LocationLine company={company} />
      </header>

      {company.websiteSummary && <p className="found__about">{company.websiteSummary}</p>}

      <ProductPageView product={product} />

      {a.whyNeeded && (
        <div className="found__block">
          <span className="found__label">Why our service is relevant</span>
          <p className="found__text">{a.whyNeeded}</p>
        </div>
      )}

      {shown.length > 0 && (
        <div className="found__block">
          <span className="found__label">Issues identified</span>
          <ul className="found__gaps">
            {shown.map((g) => (
              <li key={g.key} className={`found__gap found__gap--${g.severity}`}>
                <strong>{g.title}.</strong> {g.detail}
              </li>
            ))}
          </ul>
          {minor.length > 0 && (
            <p className="found__minor">Also noted: {minor.map((g) => g.title.toLowerCase()).join(', ')}.</p>
          )}
        </div>
      )}

      {a.missingInformation.length > 0 && (
        <div className="found__block">
          <span className="found__label">Missing information</span>
          <div className="found__chips">
            {a.missingInformation.map((m) => (
              <Chip key={m.label} title={m.recommendation}>
                {m.label}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {a.recommendedActions.length > 0 && (
        <div className="found__block">
          <span className="found__label">What our service would do</span>
          <ol className="found__actions">
            {a.recommendedActions.slice(0, 3).map((r) => (
              <li key={r.title}>
                <strong>{r.title}.</strong> {r.remediation}
              </li>
            ))}
          </ol>
        </div>
      )}

      {a.nextStep && (
        <div className="found__block">
          <span className="found__label">What the Marketing Agent should do next</span>
          <p className="found__next">{a.nextStep}</p>
        </div>
      )}

      <details className="found__details">
        <summary>How the product was read</summary>
        <div className="found__block">
          <span className="found__label">Attributes and where each was read</span>
          {product.attributes.length === 0 ? (
            <p className="found__text">The page publishes no attributes a buyer could filter on.</p>
          ) : (
            <table className="found__attrs">
              <tbody>
                {product.attributes.map((attr) => (
                  <tr key={`${attr.name}:${attr.value}`}>
                    <th scope="row">{attr.name}</th>
                    <td>{attr.value}</td>
                    <td className="found__attrsrc">{attr.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div className="found__block">
          <span className="found__label">How the information is structured</span>
          <ul className="found__facts">
            <li>
              {product.structure.fieldsPublished} of {product.structure.fieldsTotal} product-information fields published
            </li>
            {product.readBy && <li>Read by {product.readBy}</li>}
            {product.structure.descriptionSentences != null && (
              <li>
                Description:{' '}
                {product.description ? `${product.structure.descriptionSentences} sentence(s)` : 'none published'}
              </li>
            )}
            <li>
              {product.structure.structuredData.length
                ? `Structured data: ${product.structure.structuredData.join(', ')}`
                : 'No structured data (JSON-LD or microdata)'}
            </li>
            <li>{product.structure.specificationRows} specification row(s)</li>
            {product.brand && <li>Brand: {product.brand}</li>}
            {product.sku && <li>SKU: {product.sku}</li>}
            {product.category && <li>Category: {product.category}</li>}
            {product.price && <li>Price: {product.price}</li>}
          </ul>
        </div>
        {a.pagesChecked.length > 0 && (
          <div className="found__block">
            <span className="found__label">How the product was chosen</span>
            <ul className="found__facts">
              {a.pagesChecked.map((p) => (
                <li key={`${p.url}:${p.outcome}`}>
                  <span className="found__producturl">{sourceLabel(p.url)}</span> — {p.outcome}
                </li>
              ))}
            </ul>
          </div>
        )}
      </details>

      <footer className="found__cardfoot">
        {sameAddress(site, company.discoverySourceUrl) ? (
          <span className="found__ownsite">Found on its own website</span>
        ) : isSearchRedirect(company.discoverySourceUrl) ? (
          <span className="found__ownsite">Found by web search</span>
        ) : (
          <a
            className="found__source"
            href={company.discoverySourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="The page this company was found on"
          >
            Found via · {sourceLabel(company.discoverySourceUrl)}
          </a>
        )}
        {onSelect && (
          <Button variant="ghost" onClick={onSelect}>
            Select
          </Button>
        )}
      </footer>
    </article>
  )
}

/**
 * The signed-in user's previous searches, as a dropdown. Choosing one shows
 * what it found; each can be removed from the history, after a confirmation.
 */
function RecentSearches({
  searches,
  currentId,
  canDelete,
  onPick,
  onDeleted,
}: {
  searches: CompanyDiscoverySearch[]
  currentId: string | null
  canDelete: boolean
  onPick: (id: string) => void
  onDeleted: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const current = searches.find((s) => s.id === currentId) ?? null

  // Closes on a click elsewhere or on Escape, like any menu.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const remove = async (id: string) => {
    setDeleting(id)
    setError(null)
    try {
      await api.del(`/company-discovery/searches/${id}`)
      setConfirming(null)
      onDeleted(id)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setDeleting(null)
    }
  }

  const meta = (s: CompanyDiscoverySearch) =>
    `${s.status === 'completed' ? `${s.totalCandidatesFound ?? 0} found` : s.status.replace(/_/g, ' ')} · ${day(s.createdAt)}`

  return (
    <div className="recent" ref={box}>
      <span className="field-label" id="recent-searches-label">
        <History size={12} aria-hidden="true" /> Recent searches
      </span>
      <button
        type="button"
        className="recent__toggle"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-labelledby="recent-searches-label"
        onClick={() => {
          setOpen((v) => !v)
          setConfirming(null)
        }}
      >
        <span className="recent__current">{current ? current.objective : 'Choose a previous search'}</span>
        {current && <span className="recent__meta">{meta(current)}</span>}
        <ChevronDown size={14} aria-hidden="true" />
      </button>

      {open && (
        <ul className="recent__menu" role="listbox" aria-label="Recent searches">
          {searches.map((s) => {
            const running = s.status === 'queued' || s.status === 'running'
            return (
              <li key={s.id} role="option" aria-selected={s.id === currentId} className={`recent__item${s.id === currentId ? ' is-active' : ''}`}>
                <button
                  type="button"
                  className="recent__pick"
                  onClick={() => {
                    onPick(s.id)
                    setOpen(false)
                  }}
                >
                  <span className="recent__name">{s.objective}</span>
                  <span className="recent__meta">{meta(s)}</span>
                </button>
                {canDelete &&
                  (confirming === s.id ? (
                    <span className="recent__confirm">
                      <Button size="sm" variant="danger" busy={deleting === s.id} onClick={() => void remove(s.id)}>
                        Delete
                      </Button>
                      <Button size="sm" variant="quiet" onClick={() => setConfirming(null)}>
                        Cancel
                      </Button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="recent__delete"
                      aria-label={`Delete search “${s.objective}”`}
                      title={running ? 'This search is still running' : 'Delete from history'}
                      disabled={running}
                      onClick={() => setConfirming(s.id)}
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
      {error && <p className="note note--caveat">{error}</p>}
    </div>
  )
}

/** A date for a history row. */
function day(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

/**
 * Where the company is — "Akron, OH" — as its own website or the listing that
 * named it states; the full address and where it was read are one hover away.
 * Nothing is shown when no page stated an address.
 */
function LocationLine({ company }: { company: DiscoveredCompany }) {
  const l = company.productAnalysis?.companyLocation
  if (!l) return null
  const short = [l.city, l.region].filter(Boolean).join(', ') || l.text
  return (
    <span className="found__location" title={`${l.text} — from the ${l.source}`}>
      <MapPin size={11} aria-hidden="true" />
      {short}
    </span>
  )
}

/** One line per company, for the groups that are not opportunities. */
function CompactGroup({
  title,
  hint,
  rows,
  reasonOf,
  linkOf,
  onSelect,
}: {
  title: string
  hint: string
  rows: DiscoveredCompany[]
  reasonOf: (c: DiscoveredCompany) => string
  linkOf: (c: DiscoveredCompany) => string
  onSelect?: (c: DiscoveredCompany) => void
}) {
  const [page, setPage] = useState(1)
  if (rows.length === 0) return null
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
  return (
    <section className="found__group" aria-label={title}>
      <header className="found__grouphead">
        <h3 className="found__groupname">{title}</h3>
        <Chip>{rows.length}</Chip>
        <p className="found__grouphint">{hint}</p>
      </header>
      <ul className="found__unread">
        {shown.map((c) => {
          const link = linkOf(c)
          // A company whose product WAS read shows that product page too.
          const product = c.productAnalysis?.status === 'analysed' ? c.productAnalysis.product : null
          return (
            <li key={c.id} className={`found__unreadrow${product ? ' found__unreadrow--product' : ''}`}>
              <span className="found__unreadmain">
                <span className="found__unreadname" title={c.discoverySourceUrl}>
                  {displayName(c)}
                </span>
                <LocationLine company={c} />
                <span className="found__unreadwhy">{reasonOf(c)}</span>
              </span>
              {isSearchRedirect(link) ? (
                <span className="found__ownsite">Found by web search</span>
              ) : (
                <a className="found__source" href={websiteUrl(link)} target="_blank" rel="noopener noreferrer">
                  {sourceLabel(link)}
                </a>
              )}
              {onSelect && (
                <Button variant="ghost" onClick={() => onSelect(c)}>
                  Select
                </Button>
              )}
              {product && (
                <details className="found__pdpdetails">
                  <summary>Product page details</summary>
                  <ProductPageView product={product} />
                </details>
              )}
            </li>
          )
        })}
      </ul>
      <Pager label={title} page={current} pages={pages} total={rows.length} onPage={setPage} />
    </section>
  )
}

/** One opportunity section — cards, ten to a page. Hidden when empty. */
function OpportunityGroup({
  title,
  hint,
  tone,
  rows,
  onSelect,
}: {
  title: string
  hint: string
  tone: 'ok' | 'warn'
  rows: DiscoveredCompany[]
  onSelect?: (c: DiscoveredCompany) => void
}) {
  const [page, setPage] = useState(1)
  if (rows.length === 0) return null
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const shown = rows.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
  return (
    <section className="found__group" aria-label={title}>
      <header className="found__grouphead">
        <h3 className="found__groupname">{title}</h3>
        <Chip tone={tone}>{rows.length}</Chip>
        <p className="found__grouphint">{hint}</p>
      </header>
      <div className="found__grid found__grid--wide">
        {shown.map((c) => (
          <ProspectCard key={c.id} company={c} onSelect={onSelect ? () => onSelect(c) : undefined} />
        ))}
      </div>
      <Pager label={title} page={current} pages={pages} total={rows.length} onPage={setPage} />
    </section>
  )
}

/**
 * Page 1 → 1–10, page 2 → 11–20 … Hidden when everything fits on one page.
 */
function Pager({
  label,
  page,
  pages,
  total,
  onPage,
}: {
  label: string
  page: number
  pages: number
  total: number
  onPage: (p: number) => void
}) {
  if (pages <= 1) return null
  const from = (page - 1) * PAGE_SIZE + 1
  const to = Math.min(total, page * PAGE_SIZE)
  return (
    <nav className="found__pager" aria-label={`${label} pages`}>
      <span className="found__pagerinfo">
        {from}–{to} of {total}
      </span>
      <button type="button" className="found__pagebtn" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        Previous
      </button>
      {Array.from({ length: pages }, (_, i) => i + 1).map((p) => (
        <button
          key={p}
          type="button"
          className={`found__pagebtn${p === page ? ' is-active' : ''}`}
          aria-current={p === page ? 'page' : undefined}
          aria-label={`Page ${p}`}
          onClick={() => onPage(p)}
        >
          {p}
        </button>
      ))}
      <button type="button" className="found__pagebtn" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        Next
      </button>
    </nav>
  )
}

/** A search engine's redirect link — where the search pointed, not a page worth showing. */
function isSearchRedirect(url: string): boolean {
  return /^https?:\/\/[^/]*vertexaisearch\.cloud\.google\.com\//i.test(url)
}

/** Why a found company has no analysed product, in one line. */
function notAnalysedReason(c: DiscoveredCompany): string {
  if (c.productAnalysis?.statusReason) return c.productAnalysis.statusReason
  return 'Found before product analysis was added. Run the search again to check one of its products.'
}

/**
 * The company already chosen in Shared context, as the centre of the screen.
 *
 * Built from the context reference and nothing else. Every cell is a field
 * that reference carries; a field it does not carry says so. It borrows
 * nothing from a search and nothing from the enrichment register — the
 * register is where the sidebar's counts come from, and it is not this
 * company's discovery result either.
 */
function SelectedCompany({
  company,
  identity,
  accent,
  onStart,
  onDiscoverInstead,
}: {
  company: CompanyRef
  /** The live answer to "is this an NXT Sales record?"; null while checking. */
  identity: CompanyIdentity | null
  accent: string
  onStart?: () => void
  onDiscoverInstead: () => void
}) {
  const name = company.companyName ?? company.crmCompanyId
  // Discovery stores a bare domain in `website`; enrichment stores a full URL
  // in `sourceUrl`. Either is shown as held, with a scheme added only so the
  // link opens.
  const site = company.website ?? company.sourceUrl ?? null
  const kind = identity?.kind ?? null
  const isCrm = kind === 'crm'
  const isDiscovered = kind === 'discovered'

  const subtitle = !identity
    ? 'Checking whether NXT Sales holds this company…'
    : isCrm
      ? 'Already in NXT Sales. The pipeline starts here, without a discovery run'
      : isDiscovered
        ? 'Found by a Prospects search — not an NXT Sales record. The pipeline starts here'
        : kind === 'not_in_crm'
          ? 'NXT Sales holds no record with this id'
          : 'NXT Sales could not be checked, so this company is not shown as an NXT Sales record'

  return (
    <Panel title="Selected company" subtitle={subtitle}>
      <div className="lead lead--picked" style={{ ['--e' as string]: accent }}>
        <div>
          <p className="lead__kicker">
            <Building2 size={12} aria-hidden="true" />
            Selected company
          </p>
          <h3 className="lead__name">{name}</h3>
          <div className="lead__chips">
            <Chip tone="ok">In shared context</Chip>
            {identity ? (
              <Chip tone={isCrm ? 'neutral' : isDiscovered ? 'info' : 'warn'} title={identity.reason}>
                {IDENTITY_LABEL[identity.kind]}
              </Chip>
            ) : (
              <Chip>Checking NXT Sales…</Chip>
            )}
            {isDiscovered ? (
              <StatusBadge status="complete" label="Discovery: FOUND BY SEARCH" size="sm" />
            ) : (
              <StatusBadge status="idle" label="Discovery: NOT RUN" size="sm" />
            )}
          </div>
        </div>

        <div className="lead__grid">
          <div className="lead__cell">
            <span className="lead__label">Website</span>
            <span className="lead__value">
              {site ? (
                <a href={websiteUrl(site)} target="_blank" rel="noopener noreferrer">
                  {site.replace(/^https?:\/\//i, '')}
                </a>
              ) : (
                <Unset what="Not on the shared-context record" />
              )}
            </span>
          </div>
          {/* A CRM id is shown only for a record NXT Sales holds right now. */}
          {isCrm && identity?.crmCompanyId ? (
            <div className="lead__cell">
              <span className="lead__label">CRM record</span>
              <span className="lead__value mono">{identity.crmCompanyId}</span>
            </div>
          ) : isDiscovered ? (
            <div className="lead__cell">
              <span className="lead__label">Found by search</span>
              <span className="lead__value">{identity?.searchObjective ?? <Unset what="Search not recorded" />}</span>
            </div>
          ) : (
            <div className="lead__cell">
              <span className="lead__label">CRM record</span>
              <span className="lead__value">
                <Unset what={identity ? (kind === 'not_in_crm' ? 'Not in NXT Sales' : 'Not verified') : 'Checking…'} />
              </span>
            </div>
          )}
          <div className="lead__cell">
            <span className="lead__label">Source</span>
            <span className="lead__value">{identity ? IDENTITY_LABEL[identity.kind] : <Unset what="Checking…" />}</span>
          </div>
          {/* Only the fields the reference carries. Their absence is "not
              carried", not "not recorded" — and a cell that said the latter
              would be claiming something about the CRM. */}
          {company.industry && (
            <div className="lead__cell">
              <span className="lead__label">Industry</span>
              <span className="lead__value">{company.industry}</span>
            </div>
          )}
          {company.location && (
            <div className="lead__cell">
              <span className="lead__label">Location</span>
              <span className="lead__value">{company.location}</span>
            </div>
          )}
        </div>

        {isDiscovered ? (
          <p className="lead__why">
            <span className="lead__whylabel">Where this company comes from</span>
            {name} was found by a Prospects search of the public web. NXT Sales holds no record of it, so it has no CRM
            id; nothing has been written to the CRM.
          </p>
        ) : isCrm ? (
          <p className="lead__why">
            <span className="lead__whylabel">Why there is no discovery result here</span>
            {name} was chosen in Shared context, not returned by a search. It is an existing NXT Sales record: no provider
            was asked for it, no discovery run was created, and no later screen will say it was found here.
          </p>
        ) : identity ? (
          <p className="lead__why">
            <span className="lead__whylabel">Not confirmed as an NXT Sales record</span>
            {identity.reason}
          </p>
        ) : null}

        <div className="lead__foot">
          <p className="lead__next">
            Starting the pipeline carries this company into Enrichment, which reads what its website publishes. Nothing
            is written to the CRM.
          </p>
          <Button icon={Search} onClick={onDiscoverInstead}>
            Find new companies instead
          </Button>
          {onStart && (
            <Button icon={ArrowRight} variant="primary" onClick={onStart}>
              Start pipeline for this company
            </Button>
          )}
        </div>
      </div>
    </Panel>
  )
}

/**
 * What the footer says about this stage.
 *
 * "Next in the pipeline" used to be the same link whether a company was
 * ready, a search was still queued, or a search had finished with nobody in
 * it. Each of those is a different sentence, and only one of them earns a tick.
 */
function footerFor({
  mode,
  company,
  sourceLabel,
  status,
  found,
  needing,
}: {
  mode: Mode
  company: CompanyRef | null
  /** Where the selected company comes from, as the live check found. */
  sourceLabel: string
  status: string | null
  found: number
  needing: number
}): EngineCompletion | undefined {
  if (mode === 'company' && company) {
    // Not "Prospect Discovery complete": discovery did not run. The stage is
    // satisfied because the pipeline has its company, and the label says
    // where that company came from.
    return {
      done: true,
      label:
        `Company selected — ${company.companyName ?? company.crmCompanyId} (${sourceLabel}).` +
        (sourceLabel === IDENTITY_LABEL.discovered ? ' Found by a Prospects search.' : ' Discovery not run; not needed.'),
    }
  }
  switch (status) {
    case 'failed':
      return { done: false, blockedReason: 'This search failed, so discovery has no company to carry into Enrichment.' }
    case 'completed':
      if (found === 0) {
        return {
          done: false,
          blockedReason: 'This search found no company, so discovery has nothing to carry into Enrichment.',
        }
      }
      return {
        done: true,
        label: `Discovery complete — ${found} ${found === 1 ? 'company' : 'companies'} found, ${needing} that may need our services. Select one to carry it into Enrichment.`,
      }
    default:
      // Nothing run, queued and running keep the plain link: nothing is
      // finished and nothing is blocked, and the results panel is already
      // saying which.
      return undefined
  }
}

/**
 * A clickable address for a stored URL or bare domain. The scheme is added to
 * make the value openable and nothing else is inferred from it.
 */
function websiteUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

/** The host of a URL or bare domain, without "www.", or null if it has none. */
function hostOf(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    return new URL(websiteUrl(value)).hostname.replace(/^www\./i, '')
  } catch {
    return null
  }
}

/**
 * The name to show for a discovered company.
 *
 * A company whose page could not be read has no name the platform read for
 * itself — only whatever title the search index carried, or the URL. A raw URL
 * is not a name, so its host is shown instead.
 */
function displayName(c: DiscoveredCompany): string {
  const name = c.companyName?.trim()
  if (name && !/^https?:\/\//i.test(name)) return name
  return hostOf(c.websiteUrl) ?? hostOf(c.discoverySourceUrl) ?? c.discoverySourceUrl
}

/** True when two addresses are the same page, ignoring scheme, "www." and a trailing slash. */
function sameAddress(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
  return norm(a) === norm(b)
}

/** A source URL shortened for a link label: host plus path, clipped. */
function sourceLabel(url: string): string {
  try {
    const u = new URL(websiteUrl(url))
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/$/, '') : ''
    const label = `${u.hostname.replace(/^www\./i, '')}${path}`
    return label.length > 46 ? `${label.slice(0, 45)}…` : label
  } catch {
    return url
  }
}
