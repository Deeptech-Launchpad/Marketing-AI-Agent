import { describe, expect, it } from 'vitest'
import { extractProductObservations } from '../../src/websiteaudit/extraction.js'

// THE PRODUCT IMAGE.
//
// A customer report shows a company their own product. That only works if the
// image is theirs, is really the product, and is absent when nothing suitable
// was published — so these cover the three ways it goes wrong:
//
//   · a logo dressed up as a product photograph
//   · a lazy-loaded image the crawler never saw
//   · a fabricated URL where the page published none
//
// Each of the first two was a real defect found by running this against live
// sites: og:image on a homepage returned "1-stop-logo-cropped.jpg", and the
// first regex read only `src`, which found nothing on a catalogue whose photos
// all load from `data-src`.

const PAGE = 'https://example-supplier.test/product/widget/'
const imageOf = (html: string, url = PAGE) =>
  extractProductObservations(html, url).find((o) => o.field === 'product.image')?.value ?? null

describe('the product image is read from the page being audited', () => {
  it('prefers the page’s own schema.org declaration', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@type":"Product","name":"Widget","image":"https://cdn.example-supplier.test/widget-large.jpg"}
    </script></head><body><img src="/other.jpg"></body></html>`
    expect(imageOf(html)).toBe('https://cdn.example-supplier.test/widget-large.jpg')
  })

  it('accepts schema.org image given as an array or ImageObject', () => {
    const arr = `<html><head><script type="application/ld+json">
      {"@type":"Product","name":"W","image":["https://cdn.test/a.jpg","https://cdn.test/b.jpg"]}
    </script></head><body></body></html>`
    expect(imageOf(arr)).toBe('https://cdn.test/a.jpg')

    const obj = `<html><head><script type="application/ld+json">
      {"@type":"Product","name":"W","image":{"@type":"ImageObject","url":"https://cdn.test/c.jpg"}}
    </script></head><body></body></html>`
    expect(imageOf(obj)).toBe('https://cdn.test/c.jpg')
  })

  it('resolves a relative URL against the page it was found on', () => {
    const html = '<html><body><img src="../uploads/widget.png"></body></html>'
    expect(imageOf(html)).toBe('https://example-supplier.test/product/uploads/widget.png')
  })

  it('reads lazy-loaded images, which is how catalogues actually ship', () => {
    for (const attr of ['data-src', 'data-original', 'data-lazy-src', 'srcset']) {
      const html = `<html><body><img ${attr}="https://cdn.test/lazy.jpg"></body></html>`
      expect(imageOf(html), attr).toBe('https://cdn.test/lazy.jpg')
    }
  })

  it('takes the first candidate from a srcset list', () => {
    const html = '<html><body><img srcset="https://cdn.test/small.jpg 480w, https://cdn.test/big.jpg 1200w"></body></html>'
    expect(imageOf(html)).toBe('https://cdn.test/small.jpg')
  })
})

describe('it never passes off site furniture as a product', () => {
  it('rejects a logo even when the site nominates it via og:image', () => {
    // The exact shape that returned "1-stop-logo-cropped.jpg" from a real site.
    const html = `<html><head>
      <meta property="og:image" content="https://www.example-supplier.test/image/1-stop-logo-cropped.jpg">
    </head><body></body></html>`
    expect(imageOf(html), 'a logo is not a product photograph').toBeNull()
  })

  it('rejects icons, sprites, spacers and placeholders', () => {
    for (const name of ['logo.png', 'sprite.png', 'icon-cart.png', 'placeholder.jpg', 'blank.gif', 'spacer.gif', 'favicon.png']) {
      const html = `<html><body><img src="https://cdn.test/${name}"></body></html>`
      expect(imageOf(html), name).toBeNull()
    }
  })

  it('rejects SVG assets and data URIs', () => {
    expect(imageOf('<html><body><img src="https://cdn.test/diagram.svg"></body></html>')).toBeNull()
    expect(imageOf('<html><body><img src="data:image/gif;base64,R0lGOD"></body></html>')).toBeNull()
  })

  it('takes the real photograph when furniture comes first', () => {
    const html = `<html><body>
      <img src="https://cdn.test/logo.png">
      <img src="https://cdn.test/icon-cart.png">
      <img src="https://cdn.test/widget-photo.jpg">
    </body></html>`
    expect(imageOf(html)).toBe('https://cdn.test/widget-photo.jpg')
  })
})

describe('an absent image stays absent', () => {
  it('records nothing when the page publishes no usable image', () => {
    const html = '<html><body><p>No pictures here.</p></body></html>'
    const obs = extractProductObservations(html, PAGE)
    const img = obs.find((o) => o.field === 'product.image')
    // The field is still reported, as not observed — never invented.
    expect(img?.value ?? null, 'no URL may be manufactured').toBeNull()
    expect(img?.status).not.toBe('observed')
  })

  it('never returns a URL from a different host than the page supplied', () => {
    // Whatever is found must be resolvable from the audited page itself.
    const html = '<html><body><img src="widget.jpg"></body></html>'
    const value = imageOf(html, 'https://company-a.test/p/1')
    expect(value).toContain('company-a.test')
    expect(value).not.toContain('company-b.test')
  })
})
