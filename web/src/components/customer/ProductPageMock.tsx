import { useState, type ReactNode } from 'react'
import { ExternalLink, ImageOff, Search, ShoppingCart } from 'lucide-react'
import { EvidenceButton, type EvidenceItem } from '../ui/Evidence'
import type {
  EnrichedRecord,
  IllustrativeExample,
  ProposedContent,
  RecommendedSchema,
  RecordField,
  SiteTheme,
  WebsiteShell,
} from '../../lib/types'
import './productpagemock.css'

// THE CUSTOMER'S OWN PRODUCT PAGE, BEFORE AND AFTER.
//
// The Workbench used to be three columns of fields, which is a database view
// of the argument. A merchant looking at three columns has to translate them
// back into their own site before the point lands. So this renders the product
// as a PAGE — their breadcrumb, their image, their price — and lets a viewer
// flip the same page between what it publishes today and what it would publish
// structured.
//
// WHAT IS REAL AND WHAT IS DELIBERATELY MISSING
//
// Everything drawn here is an observed value. The crawler does not record a
// logo, a navigation bar or a footer — image extraction actively discards
// logos, because a company's own logo shown where its product should be is
// worse than no image at all — so this mock has no logo, no nav and no footer
// links. It shows the site's own name (which pages publish in their <title>),
// the breadcrumb trail, and the product. Inventing the rest would make the
// demonstration a lie about the customer's website, which is the one thing it
// cannot afford to be.
//
// The AFTER view never adds a fact. It re-presents the same observed values in
// a structured shape, surfaces the attributes the rules read out of the page's
// own prose, and names the fields that are missing as recommendations to
// publish — never as values.
//
// FOUR STATES, AND THE DIFFERENCE BETWEEN THEM IS THE PRODUCT.
//
//   OBSERVED     their website published it
//   DERIVED      their own page text states it, where a filter cannot read it
//   RECOMMENDED  their category needs it and their page does not have it
//   PROPOSED     wording WE suggest — the only one that is ours
//
// The first three are statements about the customer's catalogue. The fourth is
// a suggestion about their copy, and it is drawn under its own heading, in its
// own colour, with the values it was composed from listed beside it. A
// customer who cannot tell at a glance which of the four they are looking at
// is a customer who might publish our wording as their specification.

const NOT_PUBLISHED = 'Not published on current website'

/** The one sentence shown beside every example, on every screen. Mirrors the backend's EXAMPLE_NOTE. */
const EXAMPLE_NOTE = 'Illustrative example — not your product data. Publish your real value here.'

/**
 * What a finished field looks like, labelled so it cannot be read as theirs.
 *
 * Renders nothing when there is no example: most absent fields have one, but
 * a field with none still shows its honest "not published" line above.
 */
function ExampleValue({ example }: { example?: IllustrativeExample | null }) {
  if (!example) return null
  return (
    <span className={`ppm__example ppm__example--${example.kind}`}>
      <span className="ppm__tag ppm__tag--example">Example</span>
      <span className="ppm__examplevalue">{example.value}</span>
      <span className="ppm__examplenote">{EXAMPLE_NOTE}</span>
    </span>
  )
}

/** The fields a shopper reads first, in the order a product page shows them. */
const HEADLINE_FIELDS = ['product.brand', 'product.sku', 'product.mpn', 'product.price', 'product.availability']

/**
 * A PUBLISHED PRICE OF ZERO IS NOT A PRICE.
 *
 * unicaremalta.com's product markup declares `"price": 0` on every item,
 * because it is a trade catalogue that does not show prices. Rendered as the
 * bare number the page published, that read as a large green "0" beside the
 * product — which says the item is free, and which the customer would have
 * been shown in their own demonstration.
 *
 * The value is still theirs and is still shown verbatim; what is added is what
 * it actually means. This is also a real finding for them: a marketplace or an
 * answer engine reading that markup is told the same thing.
 */
function isDeclaredZero(value: string | null): boolean {
  return value !== null && /^[^\d]*0+(?:[.,]0+)?[^\d]*$/.test(value.trim())
}

/** The price line, in both frames, so BEFORE and AFTER cannot disagree. */
function PriceLine({ price, currency }: { price: string | null; currency: string | null }) {
  if (price === null) return null
  const zero = isDeclaredZero(price)
  return (
    <p className={zero ? 'ppm__price ppm__price--zero' : 'ppm__price'}>
      {currency ? `${currency} ` : ''}
      {price}
      {zero && (
        <span className="ppm__pricenote">
          This page&rsquo;s structured data declares a price of zero, which tells a marketplace the item is free.
        </span>
      )}
    </p>
  )
}

/** Availability arrives as a schema.org URL more often than as a word. */
function readableAvailability(value: string): string {
  const m = value.match(/schema\.org\/(\w+)/i)
  if (!m) return value
  return m[1]!.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function fieldValue(f: RecordField | undefined): string | null {
  if (!f?.before) return null
  return f.field === 'product.availability' ? readableAvailability(f.before) : f.before
}

/** Markup a page published inside a description, shown as text a person reads. */
function asPlainText(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The product's own photograph, or a plain statement that it did not load. */
function MockImage({ url, name, example = false }: { url: string | null; name: string; example?: boolean }) {
  const [failed, setFailed] = useState(false)
  // AFTER only, and only when the page publishes no image at all: show WHERE
  // product photography belongs, labelled as an example. Never a stock photo —
  // a picture of another product presented as theirs would be a fabrication,
  // and a labelled frame demonstrates the improvement just as clearly.
  if (!url && example) {
    return (
      <div className="ppm__img ppm__img--example">
        <span className="ppm__tag ppm__tag--example">Example</span>
        <ImageOff size={22} aria-hidden="true" />
        <p>Product photography goes here — a main image on a clean background, plus close-ups and in-use shots.</p>
        <p className="ppm__examplenote">{EXAMPLE_NOTE}</p>
      </div>
    )
  }
  if (!url || failed) {
    return (
      <div className="ppm__img ppm__img--absent">
        <ImageOff size={22} aria-hidden="true" />
        <p>
          {url
            ? 'The product image published by the website could not be loaded.'
            : 'No product image is published on this page.'}
        </p>
      </div>
    )
  }
  return (
    <div className="ppm__img">
      <img src={url} alt={`${name}, as published on the audited page`} onError={() => setFailed(true)} loading="lazy" />
    </div>
  )
}

/**
 * The customer's own masthead, navigation and footer.
 *
 * Every element here is built from values the builder read off their live
 * product page — the logo's image URL, the navigation labels and targets, the
 * footer's links and copyright line. Nothing is markup from their site, and
 * nothing is ours.
 *
 * This is what the demonstration was missing. Without it the Workbench could
 * put a customer's product on the screen but not the page it lives on, and a
 * product on a blank card is a generic mock however accurate its data.
 *
 * The SAME shell wraps both tabs. That is the whole argument: identical site,
 * identical product, identical branding — only the product information
 * changes. A shell that differed between the two would be comparing two
 * websites rather than two versions of one.
 */
function SiteShell({
  shell,
  record,
  children,
}: {
  shell?: WebsiteShell | null
  record: EnrichedRecord
  children: ReactNode
}) {
  const ctx = record.pageContext
  const siteName = shell?.siteName ?? ctx?.siteName ?? ctx?.host ?? 'This website'
  const host = shell?.host ?? ctx?.host ?? null
  const crumbs = (ctx?.breadcrumbs ?? '')
    .split(/\s*(?:›|»|>|\/|\||→)\s*/)
    .map((c) => c.trim())
    .filter(Boolean)

  return (
    <div className="site">
      {/* The browser frame. It carries the real address, which is what makes a
          viewer read what follows as a website rather than as our layout. */}
      <div className="site__frame" aria-hidden="true">
        <span className="site__dot" />
        <span className="site__dot" />
        <span className="site__dot" />
        <span className="site__addr">{shell?.sourceUrl ?? record.sourceUrl}</span>
      </div>

      <header className="site__header">
        <div className="site__brand">
          {shell?.logoUrl ? (
            <img className="site__logo" src={shell.logoUrl} alt={shell.logoAlt ?? siteName} />
          ) : (
            <span className="site__wordmark">{siteName}</span>
          )}
        </div>

        {shell?.hasSearch && (
          <div className="site__search" aria-hidden="true">
            <Search size={13} />
            <span>Search</span>
          </div>
        )}

        {(shell?.utility.length ?? 0) > 0 && (
          <div className="site__utility">
            {shell!.utility.map((u) => (
              <span key={u.label}>{u.label}</span>
            ))}
          </div>
        )}
      </header>

      {(shell?.nav.length ?? 0) > 0 && (
        <nav className="site__nav" aria-label="Site navigation">
          {shell!.nav.map((n) => (
            <span key={n.label}>{n.label}</span>
          ))}
        </nav>
      )}

      {crumbs.length > 0 && (
        <nav className="site__crumbs" aria-label="Breadcrumb">
          {crumbs.map((c, i) => (
            <span key={`${c}-${i}`}>
              {i > 0 && <span className="site__sep" aria-hidden="true">/</span>}
              <span className={i === crumbs.length - 1 ? 'is-current' : ''}>{c}</span>
            </span>
          ))}
        </nav>
      )}

      {children}

      <footer className="site__footer">
        {(shell?.footerLinks.length ?? 0) > 0 && (
          <div className="site__footlinks">
            {shell!.footerLinks.map((l) => (
              <span key={l.label}>{l.label}</span>
            ))}
          </div>
        )}
        {(shell?.social.length ?? 0) > 0 && (
          <div className="site__social">
            {shell!.social.map((sn) => (
              <span key={sn.platform}>{sn.platform}</span>
            ))}
          </div>
        )}
        <p className="site__copy">{shell?.footerText ?? host ?? ''}</p>
      </footer>

      {/* What the capture could not read, named rather than replaced. The
          alternative is drawing our own header over theirs, which is the
          failure this whole component exists to correct. */}
      {shell && shell.notCaptured.length > 0 && (
        <p className="site__gap">{shell.notCaptured.join(', ')}: not captured by the audit.</p>
      )}
      {shell && !shell.captured && (
        <p className="site__gap">
          This page&rsquo;s header and footer could not be captured{shell.reason ? ` — ${shell.reason}` : '.'} Nothing
          has been drawn in their place.
        </p>
      )}
    </div>
  )
}

/** BEFORE: the page as it reads today, with nothing tidied but the markup. */
function BeforePage({ record, shell }: { record: EnrichedRecord; shell?: WebsiteShell | null }) {
  const by = new Map(record.fields.map((f) => [f.field, f]))
  const description = fieldValue(by.get('product.description'))
  const price = fieldValue(by.get('product.price'))
  const currency = fieldValue(by.get('product.currency'))
  const published = HEADLINE_FIELDS.map((k) => by.get(k)).filter((f): f is RecordField => Boolean(f?.before))

  return (
    <SiteShell shell={shell} record={record}>
      <div className="ppm ppm--before">
      <div className="ppm__body">
        <MockImage url={record.imageUrl} name={record.title} />
        <div className="ppm__detail">
          <h3 className="ppm__title">{record.title}</h3>

          {price !== null ? (
            <PriceLine price={price} currency={currency} />
          ) : (
            <p className="ppm__price ppm__price--absent">{NOT_PUBLISHED}</p>
          )}

          {/* Run together exactly as the page runs them together: a shopper
              reading this page has to find the brand inside a paragraph, and
              that is the point being made. */}
          <dl className="ppm__inline">
            {published
              .filter((f) => f.field !== 'product.price')
              .map((f) => (
                <div key={f.field}>
                  <dt>{f.label}</dt>
                  <dd>{fieldValue(f)}</dd>
                </div>
              ))}
          </dl>

          {description ? (
            <p className="ppm__desc">{asPlainText(description)}</p>
          ) : (
            <p className="ppm__desc ppm__desc--absent">This page publishes no product description.</p>
          )}

          <button type="button" className="ppm__cta" disabled>
            <ShoppingCart size={14} aria-hidden="true" />
            Add to cart
          </button>
        </div>
      </div>
      </div>
    </SiteShell>
  )
}

/** AFTER: the same page, the same facts, given a structure. */
/**
 * Wording AltiusNxt suggests, drawn so it can never be mistaken for the
 * customer's own copy.
 *
 * Its own heading, its own tint, an explicit note, and the source values
 * printed underneath — because "proposed" is only meaningful if a reviewer can
 * check the proposal against what it was built from without leaving the page.
 */
function ProposedBlock({ content }: { content: ProposedContent }) {
  return (
    <section className="ppm__proposed" aria-label="AltiusNxt proposed content">
      <header className="ppm__proposedhead">
        <span className="ppm__tag ppm__tag--proposed">Proposed</span>
        <h4>AltiusNxt Proposed Content</h4>
      </header>
      <p className="ppm__proposednote">{content.note}</p>

      <p className="ppm__proposedbody">{content.overview}</p>

      {content.bullets.length > 0 && (
        <ul className="ppm__proposedlist">
          {content.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}

      {content.openQuestions.length > 0 && (
        <>
          <p className="ppm__seccap">Questions this page does not yet answer</p>
          <ul className="ppm__proposedlist ppm__proposedlist--ask">
            {content.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </>
      )}

      {content.supportedBy.length > 0 && (
        <details className="ppm__support">
          <summary>Built from {content.supportedBy.length} value(s) this page publishes</summary>
          <dl className="ppm__spec">
            {content.supportedBy.map((v, i) => (
              <div key={`${v.label}-${i}`} className="ppm__row">
                <dt>{v.label}</dt>
                <dd>
                  <span className={`ppm__tag ppm__tag--${v.from}`}>{v.from === 'derived' ? 'Derived' : 'Observed'}</span>
                  {v.value}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </section>
  )
}

/** What each tag means, said once, where both views can see it. */
function StateLegend() {
  return (
    <ul className="ppm__legend" aria-label="What each label means">
      <li>
        <span className="ppm__tag ppm__tag--observed">Observed</span> published by your website
      </li>
      <li>
        <span className="ppm__tag ppm__tag--derived">Derived</span> stated in your own page text
      </li>
      <li>
        <span className="ppm__tag ppm__tag--rec">Recommended</span> your category needs it; your page has no value
      </li>
      <li>
        <span className="ppm__tag ppm__tag--proposed">Proposed</span> wording we suggest — not your data
      </li>
    </ul>
  )
}

function AfterPage({
  record,
  schema,
  proposed,
  shell,
  examples,
}: {
  record: EnrichedRecord
  schema?: RecommendedSchema | null
  proposed?: ProposedContent | null
  shell?: WebsiteShell | null
  examples?: Record<string, IllustrativeExample> | null
}) {
  const by = new Map(record.fields.map((f) => [f.field, f]))
  const price = fieldValue(by.get('product.price'))
  const currency = fieldValue(by.get('product.currency'))
  const description = fieldValue(by.get('product.description'))

  const derived = record.fields.flatMap((f) =>
    (f.derivedAttributes ?? []).map((d) => ({ ...d, from: f.label, sourceUrl: f.sourceUrl })),
  )

  // Every field that is not part of the identity strip above, and not the
  // description or the image — both of which have their own place on the page.
  const rest = record.fields.filter(
    (f) => !HEADLINE_FIELDS.includes(f.field) && f.field !== 'product.description' && f.field !== 'product.image',
  )

  const evidenceFor = (f: RecordField): EvidenceItem[] => [
    {
      title: `${f.label}, as published`,
      summary: 'Read from this page. The enriched record names it; it does not change it.',
      field: f.label,
      fragment: f.before ?? undefined,
      source: 'The audited product page',
      sourceUrl: f.sourceUrl,
    },
  ]

  return (
    <SiteShell shell={shell} record={record}>
      <div className="ppm ppm--after">
      <div className="ppm__body">
        <MockImage url={record.imageUrl} name={record.title} example />
        <div className="ppm__detail">
          <h3 className="ppm__title">{record.title}</h3>

          <PriceLine price={price} currency={currency} />

          {/* Identity first, the way a product page leads. */}
          <dl className="ppm__spec ppm__spec--head">
            {HEADLINE_FIELDS.map((k) => by.get(k)).map((f) =>
              !f ? null : (
                <div key={f.field} className={`ppm__row${f.before ? '' : ' is-absent'}`}>
                  <dt>{f.label}</dt>
                  <dd>
                    {f.before ? (
                      <>
                        <span className="ppm__tag ppm__tag--observed">Observed</span>
                        {fieldValue(f)}
                        <EvidenceButton title={f.label} label="Reference" items={evidenceFor(f)} />
                      </>
                    ) : (
                      <>
                        <span className="ppm__tag ppm__tag--rec">Recommended</span>
                        <span className="ppm__none">{NOT_PUBLISHED}</span>
                        <ExampleValue example={examples?.[f.field]} />
                        {f.recommendation && <span className="ppm__advice">{f.recommendation}</span>}
                      </>
                    )}
                  </dd>
                </div>
              ),
            )}
          </dl>

          {/* Everything else the record holds, as a specification table.
              Absent fields are kept in place rather than filtered out: a
              buyer's question is answered by the row saying "not published"
              just as much as by a row carrying a value, and dropping them
              would make a thin catalogue look complete. */}
          {rest.length > 0 && (
            <>
              <p className="ppm__seccap">Specifications</p>
              <dl className="ppm__spec">
                {rest.map((f) => (
                  <div key={f.field} className={`ppm__row${f.before ? '' : ' is-absent'}`}>
                    <dt>{f.label}</dt>
                    <dd>
                      {f.before ? (
                        <>
                          <span className="ppm__tag ppm__tag--observed">Observed</span>
                          {fieldValue(f)}
                          <EvidenceButton title={f.label} label="Reference" items={evidenceFor(f)} />
                        </>
                      ) : (
                        <>
                          <span className="ppm__tag ppm__tag--rec">Recommended</span>
                          <span className="ppm__none">{NOT_PUBLISHED}</span>
                          <ExampleValue example={examples?.[f.field]} />
                          {f.recommendation && <span className="ppm__advice">{f.recommendation}</span>}
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {derived.length > 0 && (
            <>
              <p className="ppm__seccap">Attributes, read out of this page&rsquo;s own text</p>
              <dl className="ppm__spec">
                {derived.map((d, i) => (
                  <div key={`${d.label}-${i}`} className="ppm__row">
                    <dt>{d.label}</dt>
                    <dd>
                      <span className="ppm__tag ppm__tag--derived">Derived</span>
                      {d.value}
                      <EvidenceButton
                        title={d.label}
                        label="Reference"
                        items={[
                          {
                            title: `${d.label}: ${d.value}`,
                            summary: `The page already states this inside its ${d.from.toLowerCase()}, where a filter or a feed cannot read it as a value.`,
                            whyItMatters: `Published as a named ${d.label.toLowerCase()} field, the same words become something a buyer can filter and compare on.`,
                            fragment: d.sourceText,
                            source: 'The audited product page',
                            sourceUrl: d.sourceUrl,
                            how: 'Read out of the published text by rule — the page’s own characters, nothing composed.',
                          },
                        ]}
                      />
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}

          {schema && schema.attributes.length > 0 && (
            <>
              <p className="ppm__seccap">
                {schema.determined
                  ? `Recommended for ${schema.categoryLabel.toLowerCase()}`
                  : 'Recommended fields — category not determined from the inspected pages'}
              </p>
              <dl className="ppm__spec">
                {schema.attributes
                  .filter((a) => a.state === 'recommended')
                  .map((a) => (
                    <div key={a.field} className="ppm__row is-absent">
                      <dt>{a.label}</dt>
                      <dd>
                        <span className="ppm__tag ppm__tag--rec">Recommended</span>
                        <span className="ppm__none">{NOT_PUBLISHED}</span>
                        <ExampleValue example={examples?.[`attr:${a.field}`]} />
                        <span className="ppm__advice">{a.why}</span>
                      </dd>
                    </div>
                  ))}
              </dl>
            </>
          )}

          {description && (
            <>
              <p className="ppm__seccap">Description</p>
              <p className="ppm__desc">{asPlainText(description)}</p>
            </>
          )}

          {proposed && <ProposedBlock content={proposed} />}
        </div>
      </div>
      </div>
    </SiteShell>
  )
}

/** The gaps, between the two pages rather than dominating the screen. */
function GapStrip({ record }: { record: EnrichedRecord }) {
  const absent = record.fields.filter((f) => f.state === 'absent')
  const derivedCount = record.fields.reduce((n, f) => n + (f.derivedAttributes?.length ?? 0), 0)
  if (absent.length === 0 && derivedCount === 0) return null

  return (
    <div className="ppm__gap" role="note">
      <span className="ppm__gapcap">The gap</span>
      {derivedCount > 0 && (
        <span className="ppm__chip ppm__chip--unstructured">
          {derivedCount} value(s) stated only in prose — not structured
        </span>
      )}
      {absent.map((f) => (
        <span key={f.field} className="ppm__chip ppm__chip--missing">
          {f.label} — missing
        </span>
      ))}
    </div>
  )
}

/**
 * The demonstration: one page, two states, one toggle.
 *
 * Both views render the SAME record — same company, same product, same image —
 * so switching can never become a comparison between two different things.
 */
export function ProductPageMock({
  record,
  schema,
  proposed,
  shell,
  theme,
  accent,
  examples,
  after,
}: {
  /**
   * The enriched product page, when the End PDP audit produced one. Replaces
   * the field-level AFTER view entirely; the BEFORE view is unchanged.
   */
  after?: ReactNode
  record: EnrichedRecord
  schema?: RecommendedSchema | null
  proposed?: ProposedContent | null
  shell?: WebsiteShell | null
  /**
   * Illustrative examples for the fields this page leaves empty, from the
   * customer view. Rendered in the AFTER view only, always labelled EXAMPLE.
   */
  examples?: Record<string, IllustrativeExample> | null
  /** Colours and fonts sampled from the live site. Applied inside the preview only. */
  theme?: SiteTheme | null
  accent?: string
}) {
  const [view, setView] = useState<'before' | 'after'>('before')

  // The customer's palette, scoped to the preview. Outside it the Workbench
  // keeps AltiusNXT's own system — the tabs, the label, the source link — so
  // the two are never confused for one another.
  const skin =
    theme && theme.source === 'live_sample'
      ? ({
          ['--s-primary' as string]: theme.primary,
          ['--s-accent' as string]: theme.accent,
          ['--s-ink' as string]: theme.ink,
          ['--s-surface' as string]: theme.surface,
          ['--s-muted' as string]: theme.muted,
          ['--s-font' as string]: theme.fontFamily,
          ['--s-heading' as string]: theme.headingFamily,
          ['--s-radius' as string]: theme.radius,
        } as never)
      : undefined

  return (
    <section
      className="ppmwrap"
      style={{ ...(accent ? ({ ['--e' as string]: accent } as never) : {}), ...(skin ?? {}) }}
    >
      <header className="ppmwrap__head">
        <div className="ppmwrap__toggle" role="tablist" aria-label="Product page view">
          <button
            type="button"
            role="tab"
            aria-selected={view === 'before'}
            className={`ppmwrap__tab${view === 'before' ? ' is-on' : ''}`}
            onClick={() => setView('before')}
          >
            Current website
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === 'after'}
            className={`ppmwrap__tab${view === 'after' ? ' is-on' : ''}`}
            onClick={() => setView('after')}
          >
            AltiusNXT enhanced
          </button>
        </div>
        <a className="ppmwrap__src" href={record.sourceUrl} target="_blank" rel="noreferrer noopener">
          <ExternalLink size={13} aria-hidden="true" />
          View original product page
        </a>
      </header>

      {view === 'before' ? (
        <BeforePage record={record} shell={shell} />
      ) : after ? (
        after
      ) : (
        <AfterPage record={record} schema={schema} proposed={proposed} shell={shell} examples={examples} />
      )}

      {!(after && view === 'after') && (
        <>
          <GapStrip record={record} />
          <StateLegend />
        </>
      )}
    </section>
  )
}
