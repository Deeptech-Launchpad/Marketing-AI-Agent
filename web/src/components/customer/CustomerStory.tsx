import { useEffect, useState } from 'react'
import { ImageOff, ExternalLink, ArrowRight } from 'lucide-react'
import { Chip } from '../ui/primitives'
import { EvidenceButton, type EvidenceItem } from '../ui/Evidence'
import type {
  CustomerViewGap,
  DerivedAttribute,
  EnrichedRecord,
  RecommendedAttribute,
  RecommendedSchema,
  RecordField,
} from '../../lib/types'
// Styled beside the Workbench, the screen these rows were built for, and
// imported here as well so the report screen cannot render them unstyled.
import '../../engines/workbench.css'

// THE CUSTOMER-FACING STORY, SHARED BY THE REPORT AND THE WORKBENCH.
//
// Both screens tell the same story about the same product, so they render it
// with the same components. The alternative — two implementations of "before
// and after" — is how the PDF and the screens drifted apart in the first
// place.
//
// One rule governs everything here, and it is the reason the product is worth
// anything to a customer who checks it:
//
//   The AFTER column adds STRUCTURE, never CONTENT.
//
// A field the page did not publish is printed as "Not published on current
// website" on BOTH sides. It is never filled in, never inferred from the
// product name, and never borrowed from a similar product.
//
// What "structure" looks like on screen is the part that used to fall down. A
// restructured field printed the customer's paragraph on the left and the same
// paragraph on the right, and a manager reading it concluded — correctly, from
// what was in front of them — that nothing had happened. So the AFTER column
// now renders what the record actually carries: the attributes read out of
// that paragraph as named rows, and, where a field is absent, the words "Not
// published on current website" beside what to publish instead.

/** The exact words used wherever a value does not exist. Never varied. */
export const NOT_PUBLISHED = 'Not published on current website'

/**
 * The product's own photograph, or a plain statement that there wasn't one.
 *
 * A remote image can 404, hotlink-block, or be pulled after the crawl. A
 * broken frame in front of a customer is worse than an honest sentence, so a
 * failed load falls back to the same treatment as a page that published none.
 */
export function ProductImage({
  url,
  name,
  size = 'md',
}: {
  url: string | null
  name: string | null
  size?: 'sm' | 'md' | 'lg'
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [url])

  if (!url || failed) {
    return (
      <div className={`pimg pimg--absent pimg--${size}`}>
        <ImageOff size={18} aria-hidden="true" />
        <p>{failed ? 'The image this page published could no longer be loaded.' : 'No product image observed'}</p>
      </div>
    )
  }

  return (
    <figure className={`pimg pimg--${size}`}>
      <img
        src={url}
        alt={name ? `${name}, as published on the audited page` : 'The audited product page image'}
        onError={() => setFailed(true)}
        loading="lazy"
      />
    </figure>
  )
}

/** A link to the page a value was read from, so a reader can check it. */
export function SourceLink({ url }: { url: string | null }) {
  if (!url) return null
  return (
    <a className="src-link" href={url} target="_blank" rel="noreferrer noopener">
      <ExternalLink size={12} aria-hidden="true" />
      <span className="mono">{url.replace(/^https?:\/\//, '')}</span>
    </a>
  )
}

/**
 * SOURCE — the customer's own page, one click away from the comparison.
 *
 * An anchor wearing the button classes rather than a Button: this navigates,
 * and a person who middle-clicks or copies the link should get the page. It
 * carries the button's look because on this screen it is the third thing a
 * reader reaches for, after the two columns.
 */
export function SourcePageButton({ url, label = 'Open the product page' }: { url: string | null; label?: string }) {
  if (!url) return null
  return (
    <a className="btn btn--ghost btn--sm cstudy__src" href={url} target="_blank" rel="noreferrer noopener">
      <ExternalLink size={13} aria-hidden="true" />
      {label}
    </a>
  )
}

/**
 * The BEFORE column: only what the page actually shows a visitor.
 *
 * Deliberately NOT the full field list. A customer looking at this should
 * recognise their own page, and their page does not have empty rows on it —
 * the emptiness is the point of the gap section, not of this column.
 */
function BeforeColumn({ record }: { record: EnrichedRecord }) {
  const published = record.fields.filter((f) => f.before !== null && f.before !== '')

  return (
    <section className="ba__side ba__side--before">
      <header className="ba__head">
        <span className="ba__cap">Before</span>
        <span className="ba__sub">Current website</span>
      </header>

      <ProductImage url={record.imageUrl} name={record.title} />

      <p className="ba__title">{record.title}</p>

      {published.length === 0 ? (
        <p className="ba__none">
          This page publishes no product field a buyer or a marketplace can read as a named value.
        </p>
      ) : (
        <dl className="ba__fields">
          {published.map((f) => (
            <div key={`b-${f.field}`} className="ba__field">
              <dt>{f.label}</dt>
              <dd>{f.before}</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="ba__note">{record.beforeSummary}</p>
      <SourceLink url={record.sourceUrl} />
    </section>
  )
}

/**
 * What a reader can check behind one enriched row.
 *
 * Each attribute is shown with the stretch of the customer's own text it was
 * read out of, and the whole published value is the last item, so nothing the
 * named rows summarise is hidden from the person checking them.
 */
function attributeEvidence(f: RecordField, derived: DerivedAttribute[], sourceUrl: string | null): EvidenceItem[] {
  const items: EvidenceItem[] = derived.map((a) => ({
    title: `${a.label}: ${a.value}`,
    summary: `The page already states this, inside its ${f.label.toLowerCase()}, where a filter, a feed or a marketplace cannot read it as a value.`,
    whyItMatters: `Published as a named ${a.label.toLowerCase()} field, the same words become something a buyer can filter, compare and search on.`,
    field: f.label,
    fragment: a.sourceText,
    source: 'The audited product page',
    sourceUrl,
    how: 'Read out of the published text by rule. The value is the page’s own characters — nothing was composed, converted or rounded.',
  }))

  if (f.before) {
    items.push({
      title: `${f.label}, as the page publishes it today`,
      summary: 'The whole value this field carries on the current website, unedited.',
      field: f.label,
      fragment: f.before,
      source: 'The audited product page',
      sourceUrl,
    })
  }

  return items
}

/**
 * One row of the enriched record. Three shapes, and the difference between
 * them is the demonstration:
 *
 *   derived   the attributes the page's own text states, each as its own named
 *             row — never the paragraph reprinted under a heading
 *   absent    the words "Not published on current website" and what to publish
 *             instead; advice about the field, never a value for it
 *   plain     the observed value, named
 */
function AfterField({ field: f, sourceUrl }: { field: RecordField; sourceUrl: string | null }) {
  const derived = f.derivedAttributes ?? []

  return (
    <div className="ba__field">
      <dt>
        {f.label}
        {f.state === 'absent' ? (
          <Chip tone="warn">To publish</Chip>
        ) : (
          <Chip tone={f.state === 'restructured' ? 'info' : 'ok'}>
            {f.state === 'restructured' ? 'Structured' : 'Observed'}
          </Chip>
        )}
      </dt>

      {derived.length > 0 ? (
        <dd className="ba__val ba__val--stack">
          <ul className="deriv">
            {derived.map((a) => (
              <li key={`${a.label}-${a.value}`} className="deriv__row">
                <span className="deriv__label">{a.label}</span>
                <span className="deriv__value">{a.value}</span>
              </li>
            ))}
          </ul>
          <EvidenceButton
            items={attributeEvidence(f, derived, sourceUrl)}
            title={`${f.label} — read from the published text`}
            label="Where these came from"
          />
        </dd>
      ) : f.state === 'absent' ? (
        <dd className="ba__val ba__val--stack is-absent">
          <span>{NOT_PUBLISHED}</span>
          {f.recommendation && (
            <p className="ba__rec">
              <span className="ba__reclabel">Recommended enrichment:</span> {f.recommendation}
            </p>
          )}
        </dd>
      ) : (
        <dd className="ba__val">{f.after ?? NOT_PUBLISHED}</dd>
      )}
    </div>
  )
}

/**
 * The AFTER column: every field named, with absence stated.
 *
 * This is the whole proposition — the same facts, in a shape a buyer can
 * filter on and a system can read. Which is why it shows the fields that are
 * MISSING too: a record with a hole in it is still a record, and pretending
 * otherwise would mean inventing the hole shut. The hole is never left blank
 * either; it carries what to publish there.
 */
function AfterColumn({ record, accent }: { record: EnrichedRecord; accent?: string }) {
  return (
    <section className="ba__side ba__side--after" style={accent ? ({ ['--e' as string]: accent } as never) : undefined}>
      <header className="ba__head">
        <span className="ba__cap">After</span>
        <span className="ba__sub">AltiusNXT proposed enriched record</span>
      </header>

      {/* The SAME image. A different one would be a different product. */}
      <ProductImage url={record.imageUrl} name={record.title} />

      <dl className="ba__fields">
        {record.fields.map((f) => (
          <AfterField key={`a-${f.field}`} field={f} sourceUrl={f.sourceUrl ?? record.sourceUrl} />
        ))}
      </dl>

      <p className="ba__note">{record.afterSummary}</p>
    </section>
  )
}

/** The fields this product's page does not publish, named rather than counted. */
export function RecordGap({ record }: { record: EnrichedRecord }) {
  const absent = record.fields.filter((f) => f.state === 'absent')
  if (absent.length === 0) return null

  return (
    <div className="gapblock">
      <p className="gapblock__cap">The gap</p>
      <p className="gapblock__lead">
        {absent.length} of {record.fields.length} fields were looked for on this page and not found. Nothing has been
        supplied in their place.
      </p>
      <ul className="gap">
        {absent.map((f) => (
          <li key={`g-${f.field}`} className="gap__row">
            <span className="gap__label">{f.label}</span>
            <Chip tone="warn">{NOT_PUBLISHED}</Chip>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * One complete case study: BEFORE, THE GAP, AFTER, KEY TRANSFORMATION.
 *
 * The reference POC's pattern, built from this customer's own page. The gap
 * sits BETWEEN the two columns rather than under them: read after the enriched
 * record has already answered it, it lands as a footnote, and the customer PDF
 * puts it where it belongs — before, gap, after. With nothing missing there is
 * no gap to place, and the arrow takes the middle back.
 */
export function CaseStudy({
  index,
  record,
  accent,
  showGap = true,
}: {
  index: number
  record: EnrichedRecord
  accent?: string
  showGap?: boolean
}) {
  const hasGap = showGap && record.fields.some((f) => f.state === 'absent')

  return (
    <article className="cstudy">
      <header className="cstudy__band">
        <span className="cstudy__num mono">CASE STUDY {String(index).padStart(2, '0')}</span>
        <h3 className="cstudy__title">{record.title}</h3>
        <SourcePageButton url={record.sourceUrl} label="Source: open the product page" />
      </header>

      <div className={hasGap ? 'ba ba--gapped' : 'ba'}>
        <BeforeColumn record={record} />
        {hasGap ? (
          <RecordGap record={record} />
        ) : (
          <span className="ba__arrow" aria-hidden="true">
            <ArrowRight size={16} />
          </span>
        )}
        <AfterColumn record={record} accent={accent} />
      </div>

      <div className="keytrans">
        <p className="keytrans__cap">Key transformation</p>
        <p className="keytrans__body">{record.keyTransformation}</p>
      </div>
    </article>
  )
}

/** The catalogue-wide gaps, worst first — "KEY DATA GAPS". */
export function DataGaps({ gaps }: { gaps: CustomerViewGap[] }) {
  if (gaps.length === 0) {
    return (
      <p className="note">
        Every field looked for was published on the inspected product pages. That is the position worth protecting as
        the catalogue grows.
      </p>
    )
  }

  return (
    <ul className="dgaps">
      {gaps.map((g) => (
        <li key={g.field} className="dgaps__row">
          <div className="dgaps__head">
            <span className="dgaps__label">{g.label}</span>
            <Chip tone={g.published === 0 ? 'danger' : 'warn'}>
              {g.published} of {g.sample}
            </Chip>
          </div>
          <p className="dgaps__stmt">{g.statement}</p>
        </li>
      ))}
    </ul>
  )
}

// ── THE RECOMMENDED ENRICHMENT SCHEMA ────────────────────────────────────
//
// What the customer should publish, for the category THEIR site says they
// sell in — and which of those fields their page already carries. Three row
// shapes, and the difference between them is the whole block:
//
//   observed     the page publishes it as a field; the value is the page's
//   derived      the page states it inside its prose; the value is the page's
//   recommended  the page does not publish it; the field is named, the value
//                is NOT — there is nothing of the customer's to put there
//
// The third shape is enforced here as well as in the data. A recommended row
// is rendered from a component that has no value slot at all, so a value
// could not reach the screen even if one arrived.

const STATE_CHIP: Record<RecommendedAttribute['state'], { label: string; tone: 'ok' | 'info' | 'warn' }> = {
  observed: { label: 'Observed', tone: 'ok' },
  derived: { label: 'Read from its text', tone: 'info' },
  recommended: { label: 'Recommended', tone: 'warn' },
}

/** A field the page publishes, or states in its prose: the value and where it was read. */
function SchemaValueRow({ attribute: a }: { attribute: RecommendedAttribute }) {
  const chip = STATE_CHIP[a.state]
  return (
    <li className={`rschema__row rschema__row--${a.state}`}>
      <div className="rschema__head">
        <span className="rschema__label">{a.label}</span>
        <Chip tone={chip.tone}>{chip.label}</Chip>
      </div>
      <p className="rschema__value">{a.value}</p>
      {a.source && (
        <p className="rschema__source">
          {a.state === 'derived' ? (
            <>
              <span className="rschema__srccap">Read from</span> &ldquo;{a.source}&rdquo;
            </>
          ) : (
            a.source
          )}
        </p>
      )}
      <p className="rschema__why">
        <span className="rschema__whycap">Why</span> {a.why}
      </p>
    </li>
  )
}

/**
 * A field the page does not publish. No value slot: the field is named and
 * the reason a buyer needs it is given, and that is all there is to say.
 */
function SchemaRecommendedRow({
  attribute: a,
  checked,
}: {
  attribute: RecommendedAttribute
  /** Whether a product page was actually checked for it. */
  checked: boolean
}) {
  return (
    <li className="rschema__row rschema__row--recommended">
      <div className="rschema__head">
        <span className="rschema__label">{a.label}</span>
        <Chip tone="warn">Recommended</Chip>
      </div>
      <p className="rschema__absent">{checked ? NOT_PUBLISHED : 'Not checked against a product page'}</p>
      <p className="rschema__why">
        <span className="rschema__whycap">Why</span> {a.why}
      </p>
    </li>
  )
}

/**
 * The block, as the Workbench renders it under THE GAP / AFTER.
 *
 * `caseStudies` is the story the schema arrived with. The schema names the
 * page its states were computed against, and that page must be one of this
 * run's own case studies before a single value is drawn — a value shown here
 * is a claim about THIS customer's page, and the check is what makes the
 * claim safe to make.
 */
export function RecommendedSchemaBlock({
  schema,
  caseStudies,
  accent,
}: {
  schema: RecommendedSchema
  caseStudies: EnrichedRecord[]
  accent?: string
}) {
  const against = schema.assessedAgainst
  const checkedHere = !against || caseStudies.some((c) => c.pageId === against.pageId)
  const evidence = schema.matchedEvidence ?? []

  return (
    <section
      className="rschema"
      style={accent ? ({ ['--e' as string]: accent } as never) : undefined}
      aria-label="Recommended enrichment"
    >
      <header className="rschema__band">
        <p className="rschema__cap">Recommended enrichment</p>
        <h3 className="rschema__title">
          {schema.determined
            ? `Recommended enrichment for ${schema.categoryLabel}`
            : 'Category not determined from the inspected pages'}
        </h3>
        {/* The classifier's own sentence, verbatim: how the category was read,
            or the specific reason it could not be. When it could not be, this
            is the headline rather than a sector label, because a sector label
            here would be a guess dressed up as a reading. */}
        <p className="rschema__note">{schema.note}</p>
      </header>

      {!checkedHere ? (
        <p className="rschema__basis rschema__basis--refused">
          The schema was assessed against a page that is not one of this run&rsquo;s case studies, so none of
          its values are shown. Nothing from another record is drawn here.
        </p>
      ) : against ? (
        <p className="rschema__basis">
          <span className="rschema__whycap">Checked against</span>{' '}
          <a className="src-link" href={against.sourceUrl} target="_blank" rel="noreferrer noopener">
            <ExternalLink size={12} aria-hidden="true" />
            <span>{against.title}</span>
          </a>{' '}
          &mdash; {schema.observedCount} published as a field, {schema.derivedCount} read from its text,{' '}
          {schema.recommendedCount} recommended.
        </p>
      ) : (
        <p className="rschema__basis">
          <span className="rschema__whycap">Not checked against any product page</span> This run inspected no
          product page, so every field below is recommended and none carries a value. That is not a finding
          that the fields are missing — it is that there was no page to check them on.
        </p>
      )}

      {checkedHere && (
        <ul className="rschema__rows">
          {schema.attributes.map((a) =>
            // A recommended attribute goes through the component with no value
            // slot, whatever `value` says; the data promises null, and the
            // screen does not rely on the promise.
            a.state === 'recommended' ? (
              <SchemaRecommendedRow key={a.field} attribute={a} checked={against !== null} />
            ) : (
              <SchemaValueRow key={a.field} attribute={a} />
            ),
          )}
        </ul>
      )}

      {evidence.length > 0 && (
        <details className="rschema__evidence">
          <summary>
            {schema.determined ? 'Where the category was read from' : 'The nearest matches, and why they were not enough'} (
            {evidence.length})
          </summary>
          <ul>
            {evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </details>
      )}

      <p className="rschema__foot">
        Fields, never values. Where a value is shown it is this website&rsquo;s own published text; a recommended
        field carries none, because the only value it could carry is one that was made up.
      </p>
    </section>
  )
}

/** Exported for tests that assert absence is never filled in. */
export type { RecordField }
