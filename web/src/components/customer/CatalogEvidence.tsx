import { Chip } from '../ui/primitives'
import type { CatalogEntry, ProductEvidence } from '../../lib/types'
import './catalogEvidence.css'

// WHAT THE WORKBENCH SHOWS WHEN THERE IS NO PRODUCT PAGE.
//
// The Workbench had one demonstration and one fallback: the customer's product
// page, or a panel reading "No product page carried enough published data". A
// real customer — unicaremalta.com — has a full catalogue of grab rails and
// shower seats, publishes no product page a machine can read, and got the
// fallback. The panel was true about our crawler and false about their
// business, and a manager opening it learned nothing.
//
// This is the honest middle. It shows the products the company really names on
// its own pages, with the evidence for each one, and states exactly what is
// missing around them. Every value on this screen was read from that company's
// own markup:
//
//   · the name, verbatim
//   · the image, from their own server
//   · the image's FILE NAME, labelled as a file name — never as a SKU, because
//     the company has not published a code and a file name is not one
//
// Nothing is composed, completed or inferred. A field the site does not
// publish is shown as not published, which is the entire point of the exercise.

const STRENGTH_LABEL: Record<CatalogEntry['strength'], string> = {
  linked: 'Named and linked on their catalogue page',
  named: 'Named in their product grid',
  image_alt: 'Named only in image alt text',
}

/** The fields a structured record would carry, none of which this site publishes. */
const MISSING_FIELDS = [
  'Product code / SKU',
  'Manufacturer part number',
  'Brand',
  'Description',
  'Technical specifications',
  'Price',
  'Availability',
]

function EntryCard({ entry }: { entry: CatalogEntry }) {
  return (
    <li className="cate__card">
      <div className="cate__thumb">
        {entry.imageUrl ? (
          // Their own image, from their own server. Referrer suppressed so
          // opening this screen is not a visit recorded against the customer.
          <img src={entry.imageUrl} alt={entry.name} loading="lazy" referrerPolicy="no-referrer" />
        ) : (
          <span className="cate__noimg">No image published</span>
        )}
      </div>
      <div className="cate__body">
        <p className="cate__name">{entry.name}</p>
        <p className="cate__how">{STRENGTH_LABEL[entry.strength]}</p>
        {entry.imageFileName && (
          <p className="cate__file">
            <span className="eyebrow">Image file name</span> <code>{entry.imageFileName}</code>
            <span className="cate__caveat"> — a file name on their server, not a published product code.</span>
          </p>
        )}
        {entry.detailUrl && (
          <a className="cate__link" href={entry.detailUrl} target="_blank" rel="noreferrer noopener">
            Their page for this item
          </a>
        )}
      </div>
    </li>
  )
}

/**
 * The catalogue this company publishes, and what a machine cannot read in it.
 *
 * Rendered for evidence states C (products named, no product page) and, when
 * the run reached neither, replaced entirely by the state's own explanation —
 * see `evidence.detail`, which is written per state and never generic.
 */
export function CatalogEvidencePanel({ evidence, companyName }: { evidence: ProductEvidence; companyName: string }) {
  const shown = evidence.entries.slice(0, 12)
  const more = evidence.entries.length - shown.length

  return (
    <div className="cate">
      <div className="cate__head">
        <Chip tone="warn">{`Tier ${evidence.tier}`}</Chip>
        <span className="cate__tier">{evidence.tierLabel}</span>
      </div>

      <p className="cate__detail">{evidence.detail}</p>

      {shown.length > 0 && (
        <>
          <h4 className="cate__h">
            {evidence.entries.length} product{evidence.entries.length === 1 ? '' : 's'} {companyName} names on their own
            website
          </h4>
          <ul className="cate__grid">
            {shown.map((e, i) => (
              <EntryCard key={`${e.name}-${i}`} entry={e} />
            ))}
          </ul>
          {more > 0 && <p className="note cate__more">And {more} more found on the same pages.</p>}

          <div className="cate__gap">
            <h4 className="cate__h">What a buyer, a marketplace or an answer engine cannot read</h4>
            <p className="note">
              For every item above, this website publishes a name and a picture and nothing else. None of the
              following is stated anywhere a machine can read it, so none of it has been filled in here:
            </p>
            <ul className="cate__missing">
              {MISSING_FIELDS.map((f) => (
                <li key={f}>
                  <span className="cate__mfield">{f}</span>
                  <span className="cate__mstate">Not published on current website</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
