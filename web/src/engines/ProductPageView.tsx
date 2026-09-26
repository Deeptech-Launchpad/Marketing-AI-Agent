import { useState } from 'react'
import { Download, ExternalLink, ImageOff, ShoppingCart } from 'lucide-react'
import type { ProductPageAnalysis, ProductPageDetails } from '../lib/types'

// THE PRODUCT PAGE, AS THE BUYER SEES IT.
//
// Laid out like the page itself: the picture, the price box with how the
// product is sold and what a buyer can do (add to cart, request a quote), the
// downloads, and the full specification table. Every value was read off the
// company's own page and is shown as the page states it; anything the page
// does not show is said to be absent rather than left blank or filled in.

type Product = NonNullable<ProductPageAnalysis['product']>

/** A product analysed before the page details were captured still shows what was read then. */
function detailsOf(product: Product): { page: ProductPageDetails; partial: boolean } {
  if (product.page) return { page: product.page, partial: false }
  const identifiers: ProductPageDetails['identifiers'] = []
  if (product.sku) identifiers.push({ label: 'SKU', value: product.sku })
  if (product.brand) identifiers.push({ label: 'Brand', value: product.brand })
  return {
    partial: true,
    page: {
      title: product.name,
      images: product.imageUrl ? [product.imageUrl] : [],
      identifiers,
      price: product.price ? { amount: product.price, currency: null, label: null, source: 'structured data' } : null,
      priceNote: null,
      availability: null,
      ordering: [],
      buyingOptions: [],
      downloads: [],
    },
  }
}

function money(p: NonNullable<ProductPageDetails['price']>): string {
  const symbol = p.currency === 'USD' || p.currency === '$' ? '$' : p.currency === 'GBP' ? '£' : p.currency === 'EUR' ? '€' : null
  if (symbol) return `${symbol}${p.amount}`
  return p.currency ? `${p.amount} ${p.currency}` : p.amount
}

export function ProductPageView({ product }: { product: Product }) {
  const { page, partial } = detailsOf(product)
  const [shown, setShown] = useState(0)
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const images = page.images.filter((u) => !broken.has(u))
  const current = images[Math.min(shown, images.length - 1)] ?? null
  const specs = product.attributes.filter((a) => a.source !== 'description text')

  return (
    <section className="pdp" aria-label={`Product page: ${product.name}`}>
      <header className="pdp__head">
        <span className="found__label">Product page</span>
        <a className="pdp__name" href={product.url} target="_blank" rel="noopener noreferrer">
          {product.name}
          <ExternalLink size={12} aria-hidden="true" />
        </a>
        <span className="found__producturl" title={product.url}>
          {product.url}
        </span>
        {product.category && <span className="pdp__crumb">{product.category}</span>}
      </header>

      <div className="pdp__top">
        <div className="pdp__media">
          {current ? (
            <a href={current} target="_blank" rel="noopener noreferrer" className="pdp__imgbox">
              <img
                src={current}
                alt={`Product image: ${product.name}`}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setBroken((b) => new Set(b).add(current))}
              />
            </a>
          ) : (
            <div className="pdp__imgbox pdp__imgbox--empty">
              <ImageOff size={18} aria-hidden="true" />
              <span>{page.images.length ? 'Image could not be loaded' : 'No product image on the page'}</span>
            </div>
          )}
          {images.length > 1 && (
            <div className="pdp__thumbs" role="group" aria-label="Product images">
              {images.map((u, i) => (
                <button
                  key={u}
                  type="button"
                  className="pdp__thumb"
                  aria-pressed={u === current}
                  aria-label={`Image ${i + 1}`}
                  onClick={() => setShown(i)}
                >
                  <img src={u} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken((b) => new Set(b).add(u))} />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pdp__main">
          {page.identifiers.length > 0 && (
            <dl className="pdp__ids">
              {page.identifiers.map((i) => (
                <div key={i.label}>
                  <dt>{i.label}</dt>
                  <dd>{i.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {product.description ? (
            <p className="pdp__desc">{product.description}</p>
          ) : (
            <p className="pdp__absent">No product description on the page.</p>
          )}
          {product.featureBullets && product.featureBullets.length > 0 && (
            <ul className="pdp__features">
              {product.featureBullets.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          )}
        </div>

        <aside className="pdp__side">
          <div className="pdp__box">
            <h5 className="pdp__boxhead">{page.price?.label ?? 'Price'}</h5>
            <div className="pdp__boxbody">
              {page.price ? (
                <p className="pdp__price">{money(page.price)}</p>
              ) : (
                <p className="pdp__absent">{page.priceNote ? `“${page.priceNote}”` : partial ? 'Not captured for this search' : 'No price published'}</p>
              )}
              {page.availability && <p className="pdp__avail">{page.availability}</p>}
              {page.ordering.length > 0 && (
                <dl className="pdp__order">
                  {page.ordering.map((o) => (
                    <div key={o.label}>
                      <dt>{o.label}</dt>
                      <dd>{o.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {page.buyingOptions.length > 0 ? (
                <ul className="pdp__buy">
                  {page.buyingOptions.map((b) => (
                    <li key={b}>
                      <ShoppingCart size={12} aria-hidden="true" /> {b}
                    </li>
                  ))}
                </ul>
              ) : (
                !partial && <p className="pdp__absent">No add-to-cart or quote option on the page</p>
              )}
            </div>
          </div>

          <div className="pdp__box">
            <h5 className="pdp__boxhead">Downloads</h5>
            <div className="pdp__boxbody">
              {page.downloads.length > 0 ? (
                <ul className="pdp__downloads">
                  {page.downloads.map((d) => (
                    <li key={d.url}>
                      <a href={d.url} target="_blank" rel="noopener noreferrer">
                        <Download size={12} aria-hidden="true" /> {d.label}
                      </a>
                      {d.fileType && <span className="pdp__filetype">{d.fileType}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="pdp__absent">{partial ? 'Not captured for this search' : 'No datasheet or document linked'}</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      <div className="pdp__specs">
        <h5 className="pdp__boxhead">Specifications</h5>
        {specs.length > 0 ? (
          <table>
            <tbody>
              {specs.map((a) => (
                <tr key={`${a.name}:${a.value}`}>
                  <th scope="row">{a.name}</th>
                  <td>{a.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="pdp__absent pdp__boxbody">The page publishes no specification with a value.</p>
        )}
      </div>

      {partial && (
        <p className="note">
          This product was analysed before price, buying options and downloads were captured. Run the search again to read
          them from the page.
        </p>
      )}
    </section>
  )
}
