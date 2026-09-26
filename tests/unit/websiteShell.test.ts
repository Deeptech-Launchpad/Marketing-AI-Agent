import { describe, expect, it } from 'vitest'
import { extractWebsiteShell } from '../../src/workbench/websiteShell.js'

// WHOSE PAGE IS THIS?
//
// The Workbench could always show a customer's product. What it could not show
// was the page the product lives on, because the website audit records fields
// and nothing about the furniture around them — no logo, no navigation, no
// footer. A product floating on a blank card is a generic mock however accurate
// its data, and that is exactly what customers said when they looked at it.
//
// So these tests are about the furniture: that it is read from the real page,
// that plausible-looking substitutes are never invented, and that whatever
// could not be read is NAMED.

const PAGE = `<!doctype html><html><head><title>Widget 42 — Acme Supplies</title></head><body>
  <header class="site-header">
    <a href="/"><img src="/assets/acme-logo.svg" alt="Acme Supplies Ltd"></a>
    <form role="search"><input type="search" name="q"></form>
    <a href="/account">My account</a>
    <a href="/cart">Cart</a>
    <a href="/about">About Us</a>
    <a href="/shop">Shop Online</a>
    <a href="/contact">Contact Us</a>
    <a href="tel:+61287113520">(02) 8711 3520</a>
    <a href="/cdn-cgi/l/email-protection">[email&#160;protected]</a>
    <a href="#main">Skip to content</a>
  </header>
  <main>product</main>
  <footer>
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms &amp; Conditions</a>
    <a href="https://www.facebook.com/acmesupplies">Facebook</a>
    <a href="https://www.linkedin.com/company/acme-supplies">LinkedIn</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share this</a>
    <p>&copy; 2026 Acme Supplies Ltd. All rights reserved.</p>
  </footer>
</body></html>`

const shell = () => extractWebsiteShell(PAGE, 'https://acme.test/products/widget-42')

describe('the shell is read off the customer’s own page', () => {
  it('takes the masthead logo and resolves it against the page', () => {
    const s = shell()
    expect(s.logoUrl).toBe('https://acme.test/assets/acme-logo.svg')
    expect(s.logoAlt).toBe('Acme Supplies Ltd')
  })

  it('prefers the logo’s own alt text for the site name', () => {
    expect(shell().siteName).toBe('Acme Supplies Ltd')
  })

  it('reads the navigation in the order the page lists it', () => {
    expect(shell().nav.map((n) => n.label)).toEqual(['About Us', 'Shop Online', 'Contact Us'])
  })

  // A phone number and an obfuscated email are commonly the first two anchors
  // in a masthead. Rendered as menu items they produce a navigation bar reading
  // "(02) 8711 3520 | [email protected] | About Us".
  it('keeps contact details and skip-links out of the navigation', () => {
    const labels = shell().nav.map((n) => n.label)
    expect(labels).not.toContain('(02) 8711 3520')
    expect(labels.some((l) => /\[email/i.test(l))).toBe(false)
    expect(labels).not.toContain('Skip to content')
  })

  it('separates account and cart from navigation', () => {
    expect(shell().utility.map((u) => u.label).sort()).toEqual(['Cart', 'My account'])
  })

  it('notices a search control', () => {
    expect(shell().hasSearch).toBe(true)
  })

  it('reads the footer links and the real copyright line', () => {
    const s = shell()
    expect(s.footerLinks.map((f) => f.label)).toContain('Privacy Policy')
    expect(s.footerText).toContain('© 2026 Acme Supplies Ltd')
  })

  it('collects the company’s own social accounts and not a share widget', () => {
    const s = shell()
    expect(s.social.map((x) => x.platform).sort()).toEqual(['Facebook', 'LinkedIn'])
    expect(s.social.every((x) => !x.href.includes('sharer'))).toBe(true)
  })

  it('reports nothing missing when the page carried everything', () => {
    expect(shell().captured).toBe(true)
    expect(shell().notCaptured).toEqual([])
  })
})

describe('what could not be read is named, never replaced', () => {
  it('names each missing region rather than substituting one', () => {
    const s = extractWebsiteShell('<html><body><main>just a product</main></body></html>', 'https://acme.test/p/1')
    expect(s.captured).toBe(false)
    expect(s.notCaptured).toEqual(['Header', 'Footer'])
    expect(s.logoUrl).toBeNull()
    expect(s.nav).toEqual([])
    expect(s.footerLinks).toEqual([])
  })

  it('names a header that carried no logo', () => {
    const s = extractWebsiteShell(
      '<html><body><header><a href="/shop">Shop</a></header></body></html>',
      'https://acme.test/p/1',
    )
    expect(s.notCaptured).toContain('Logo')
    expect(s.logoUrl).toBeNull()
    // The header itself was found, so it is not reported missing.
    expect(s.notCaptured).not.toContain('Header')
  })

  it('names a header that carried no navigation', () => {
    const s = extractWebsiteShell(
      '<html><body><header><img src="/logo.png" alt="Acme"></header></body></html>',
      'https://acme.test/p/1',
    )
    expect(s.notCaptured).toContain('Navigation')
  })

  // Older catalogues mark these with a class instead of a semantic tag.
  it('finds a header marked with a class rather than a tag', () => {
    const s = extractWebsiteShell(
      '<html><body><div class="site-header"><img src="/logo.png" alt="Acme Ltd"><a href="/shop">Shop</a></div></body></html>',
      'https://acme.test/p/1',
    )
    expect(s.logoAlt).toBe('Acme Ltd')
    expect(s.nav.map((n) => n.label)).toEqual(['Shop'])
  })
})

describe('the shell is data, never markup', () => {
  // The Workbench renders its own elements from these values. That is what
  // keeps the existing promise that no prospect HTML, CSS or script is served,
  // and it is also why the enhanced tab can keep the identical shell while
  // replacing what sits inside it — a screenshot could not do that.
  it('carries no tags, scripts or styles out of the page', () => {
    const s = extractWebsiteShell(
      `<html><body><header><script>alert(1)</script><style>.x{}</style>
       <img src="/logo.png" alt="Acme <b>Ltd</b>"><a href="/shop"><span>Shop</span> <em>Online</em></a></header></body></html>`,
      'https://acme.test/p/1',
    )
    const serialised = JSON.stringify(s)
    expect(serialised).not.toContain('<script')
    expect(serialised).not.toContain('<style')
    expect(serialised).not.toContain('<span')
    expect(s.nav[0]!.label).toBe('Shop Online')
  })

  it('resolves relative link targets and drops unusable ones', () => {
    const s = extractWebsiteShell(
      '<html><body><header><a href="/shop">Shop</a><a href="#top">Top of page</a></header></body></html>',
      'https://acme.test/p/1',
    )
    expect(s.nav.find((n) => n.label === 'Shop')?.href).toBe('https://acme.test/shop')
    expect(s.nav.find((n) => n.label === 'Top of page')?.href).toBeNull()
  })
})

// ── STYLESHEETS ARE NOT FOOTER TEXT ───────────────────────────────────────
//
// Stripping tags does not remove a <style> element's CONTENTS: those are text
// nodes, so `<style>a{color:red}</style>` survives tag removal as
// `a{color:red}`. Real sites put inline styles inside headers and footers, and
// a live Squarespace footer read this way produced a copyright line with a
// stylesheet welded to it:
//
//   "© 2026 Unicare Ltd - All Rights Reserved #block-yui_3_17_2_1_… {
//    --stroke-style: none;--stroke-thickness…"
//
// That is what the customer would have seen in their own demonstration. These
// keep the invisible kind of text out of the visible kind.

describe('invisible text never reaches the demonstration', () => {
  const withStyleInFooter = (company: string, host: string) => `<!doctype html><html>
    <head><title>A Product — ${company}</title></head>
    <body>
      <header><a href="/"><img src="/logo.png" alt="${company}"></a><a href="/shop">Shop</a></header>
      <footer>
        <style>#block-yui_3_17_2_1_1754314106948_1689 { --stroke-style: none; --stroke-thickness: 1px; }</style>
        <p>© 2026 ${company} - All Rights Reserved</p>
        <a href="/privacy">Privacy</a>
        <script>window.dataLayer=[{"event":"footer"}]</script>
      </footer>
    </body></html>`

  // Two companies sharing nothing: a rule that only works for one is a rule
  // that read something it should not have.
  for (const [company, host] of [
    ['Unicare Ltd', 'unicare.test'],
    ['Lumière Sanitaire SARL', 'lumiere.test'],
  ] as Array<[string, string]>) {
    it(`keeps CSS out of the copyright line — ${company}`, () => {
      const s = extractWebsiteShell(withStyleInFooter(company, host), `https://${host}/p/1`)
      // Starts with the copyright line and carries none of the stylesheet.
      // It may run on into the next visible label — that is the existing
      // "longest line the footer offers" behaviour and is ordinary text.
      expect(s.footerText).toContain(`© 2026 ${company} - All Rights Reserved`)
      expect(s.footerText).not.toContain('{')
      expect(s.footerText).not.toContain('--stroke')
      expect(s.footerText).not.toMatch(/#block/)
    })

    it(`keeps script source out of every captured string — ${company}`, () => {
      const s = extractWebsiteShell(withStyleInFooter(company, host), `https://${host}/p/1`)
      const everything = JSON.stringify(s)
      expect(everything).not.toContain('dataLayer')
      expect(everything).not.toContain('window.')
      expect(everything).not.toContain('--stroke-style')
    })
  }

  it('still reads a footer that carries no style block at all', () => {
    const plain = `<!doctype html><html><head><title>P — Acme</title></head><body>
      <header><a href="/"><img src="/l.png" alt="Acme"></a></header>
      <footer><p>Copyright © 2026 Acme Supplies Ltd</p><a href="/privacy">Privacy</a></footer></body></html>`
    const s = extractWebsiteShell(plain, 'https://acme.test/p/1')
    expect(s.footerText).toContain('Copyright © 2026 Acme Supplies Ltd')
  })

  // An absence stays an absence: nothing is substituted for a footer that
  // genuinely has no copyright line.
  it('reports no footer text rather than inventing one', () => {
    const noCopyright = `<!doctype html><html><head><title>P — Acme</title></head><body>
      <header><a href="/"><img src="/l.png" alt="Acme"></a></header>
      <footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer></body></html>`
    const s = extractWebsiteShell(noCopyright, 'https://acme.test/p/1')
    expect(s.footerText).toBeNull()
    expect(s.footerLinks.length).toBe(2)
  })
})
