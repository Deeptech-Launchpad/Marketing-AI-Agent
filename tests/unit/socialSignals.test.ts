import { describe, expect, it } from 'vitest'
import { discoverSocialProfiles, readProfileUrl } from '../../src/intent/socialProfiles.js'
import { personalizationSignal, readSocialPage } from '../../src/intent/socialReading.js'

// WHOSE ACCOUNT IS IT, AND WHAT DID THE PLATFORM ACTUALLY SHOW US?
//
// Those are the only two questions this part of the engine answers, and both
// are easy to get wrong in a way that looks like success:
//
//   · a share button links to facebook.com/sharer — it is not the company's
//     page, and collecting it would attribute a stranger's account to them
//   · LinkedIn answers a logged-out request with a login wall that still
//     carries a correct og:title — treating that as "no signals found" tells
//     an operator the company has no presence when the platform simply
//     refused

describe('a social link is only a profile if it identifies an account', () => {
  it('reads a company page on each supported platform', () => {
    expect(readProfileUrl('https://www.linkedin.com/company/acme-supply/')).toMatchObject({
      platform: 'linkedin',
      handle: 'acme-supply',
    })
    expect(readProfileUrl('https://facebook.com/AcmeSupplyLtd')).toMatchObject({ platform: 'facebook' })
    expect(readProfileUrl('https://www.instagram.com/acmesupply/')).toMatchObject({ platform: 'instagram' })
    expect(readProfileUrl('https://x.com/acmesupply')).toMatchObject({ platform: 'x' })
    expect(readProfileUrl('https://www.youtube.com/@acmesupply')).toMatchObject({ platform: 'youtube' })
  })

  // Every commercial site has these, and every one of them would attach an
  // account to the wrong company.
  it('rejects share buttons, login walls and platform utility pages', () => {
    for (const url of [
      'https://www.facebook.com/sharer/sharer.php?u=https://acme.test/p/1',
      'https://www.facebook.com/dialog/share?app_id=1',
      'https://www.linkedin.com/uas/login',
      'https://www.linkedin.com/feed/',
      'https://twitter.com/intent/tweet?text=hi',
      'https://www.instagram.com/explore/tags/plumbing/',
      'https://www.youtube.com/results?search_query=pumps',
    ]) {
      expect(readProfileUrl(url), url).toBeNull()
    }
  })

  it('ignores a bare platform homepage, which identifies nobody', () => {
    expect(readProfileUrl('https://www.linkedin.com/')).toBeNull()
    expect(readProfileUrl('https://facebook.com')).toBeNull()
  })

  // A personal profile is a named individual. Company-profile discovery does
  // not collect people; the Decision Maker engine does, with its own rules.
  it('does not treat a personal LinkedIn profile as a company page', () => {
    expect(readProfileUrl('https://www.linkedin.com/in/some-person/')).toBeNull()
  })

  it('drops tracking parameters, which are not part of an identity', () => {
    expect(readProfileUrl('https://linkedin.com/company/acme-supply?trk=nav&utm_source=web')?.url).toBe(
      'https://linkedin.com/company/acme-supply',
    )
  })
})

describe('discovering the profiles a company publishes on its own site', () => {
  const html = `
    <html><body>
      <footer>
        <a href="https://www.linkedin.com/company/acme-supply/">Follow us on LinkedIn</a>
        <a href="/contact">Contact</a>
        <a href="https://www.facebook.com/AcmeSupplyLtd">Facebook</a>
        <a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>
        <a href="https://www.instagram.com/acmesupply/"><img src="/ig.svg" alt="Instagram"></a>
      </footer>
    </body></html>`

  it('collects the real profiles and not the share button', () => {
    const found = discoverSocialProfiles({ html, pageUrl: 'https://acme-supply.test/' })
    expect(found.map((f) => f.platform).sort()).toEqual(['facebook', 'instagram', 'linkedin'])
  })

  // Which page carried the link is what makes the account attributable, so it
  // is recorded rather than reconstructed later.
  it('records the page the link was found on', () => {
    const found = discoverSocialProfiles({ html, pageUrl: 'https://acme-supply.test/contact' })
    expect(found[0]!.discoveredOn).toBe('https://acme-supply.test/contact')
  })

  it('keeps the anchor text when there is any, and null when there is not', () => {
    const found = discoverSocialProfiles({ html, pageUrl: 'https://acme-supply.test/' })
    expect(found.find((f) => f.platform === 'linkedin')!.anchorText).toBe('Follow us on LinkedIn')
    expect(found.find((f) => f.platform === 'instagram')!.anchorText).toBeNull()
  })

  it('resolves a relative link against the page it was found on', () => {
    const found = discoverSocialProfiles({
      html: '<a href="//www.linkedin.com/company/acme-supply">in</a>',
      pageUrl: 'https://acme-supply.test/about',
    })
    expect(found[0]?.url).toBe('https://linkedin.com/company/acme-supply')
  })
})

describe('what a platform served is itself the finding', () => {
  it('names a login wall rather than reporting an empty result', () => {
    const r = readSocialPage({
      html: '<meta property="og:title" content="Acme Supply | LinkedIn"><body>Sign in to see who Acme Supply knows</body>',
      status: 200,
      platformLabel: 'LinkedIn',
    })
    expect(r.access).toBe('login_required')
    expect(r.accessNote).toContain('signed-in session')
    // The metadata behind the wall is still a real public fact and is kept.
    expect(r.title).toBe('Acme Supply | LinkedIn')
    expect(r.posts).toEqual([])
  })

  it('separates a consent interstitial from a login wall', () => {
    const r = readSocialPage({
      html: '<meta property="og:description" content="Plumbing supplies"><body>Before you continue to Facebook, accept all cookies</body>',
      status: 200,
      platformLabel: 'Facebook',
    })
    expect(r.access).toBe('consent_required')
  })

  it('reports a deleted profile as gone, not as silent', () => {
    const r = readSocialPage({ html: '', status: 404, platformLabel: 'Instagram' })
    expect(r.access).toBe('not_found')
    expect(r.accessNote).toContain('404')
  })

  it('reports a refusal as a refusal', () => {
    const r = readSocialPage({ html: '', status: 429, platformLabel: 'X (Twitter)' })
    expect(r.access).toBe('blocked')
  })

  it('reads publicly rendered posts when a platform actually serves them', () => {
    const r = readSocialPage({
      html: `<meta property="og:title" content="Acme Supply">
        <article>We are now an authorised distributor for a new range of brass fittings, available from our Malta depot.</article>
        <article>short</article>`,
      status: 200,
      platformLabel: 'Facebook',
    })
    expect(r.access).toBe('public')
    expect(r.posts).toHaveLength(1)
    expect(r.posts[0]).toContain('authorised distributor')
  })

  it('calls metadata-only what it is, rather than public', () => {
    const r = readSocialPage({
      html: '<meta property="og:title" content="Acme Supply"><meta property="og:description" content="Industrial supplies">',
      status: 200,
      platformLabel: 'Instagram',
    })
    expect(r.access).toBe('metadata_only')
    expect(r.description).toBe('Industrial supplies')
  })
})

describe('personalization stays narrow, public and non-sensitive', () => {
  const at = (posts: string[]) =>
    personalizationSignal({ posts, sourceUrl: 'https://x.com/acme', platformLabel: 'X (Twitter)' })

  it('picks up a clearly stated public interest, and quotes it verbatim', () => {
    const s = at(['Great weekend. What a finish to the Grand Prix — best race of the season by a mile.'])
    expect(s?.topic).toBe('Formula 1')
    expect(s?.quote).toContain('Grand Prix')
  })

  it('finds nothing in ordinary business posts, which is the usual answer', () => {
    expect(at(['We have restocked our full range of copper fittings this week.'])).toBeNull()
  })

  // The list is closed on purpose. Nothing in it can express a protected or
  // private characteristic, and this is the test that says so.
  it('has no rule that could match a sensitive characteristic', () => {
    for (const post of [
      'Celebrating Ramadan with the team this week.',
      'Proud to march at Pride this weekend.',
      'Back at work after my heart surgery.',
      'Voting in the election tomorrow — every vote counts.',
      'My wife and I just had our second child.',
    ]) {
      expect(at([post]), post).toBeNull()
    }
  })
})

// A WALL IS A FINDING, AND THE HEADLINE HAS TO SAY SO.
//
// The summary is what a reader takes in; the interpretation is what they read
// if the summary interests them. So "publishes a LinkedIn profile" as a
// headline, sitting beside no posts, is read as "the account is empty" — when
// what actually happened is that the platform would not let us look. These pin
// the wording that distinguishes the two.
describe('an unreadable profile says so in the headline, not only in the detail', () => {
  // Mirrors the branch in socialProvider.ts. Kept as a function of the reading
  // so the rule is testable without a network round trip.
  const headline = (access: string, company: string, platform: string): string =>
    access === 'public' || access === 'metadata_only'
      ? `${company} publishes a ${platform} profile on its own website.`
      : `Public profile detected — content could not be verified from this session. (${platform})`

  it('uses the approved wording when the platform refused', () => {
    for (const access of ['login_required', 'consent_required', 'blocked', 'unreachable']) {
      expect(headline(access, 'Acme', 'LinkedIn'), access).toBe(
        'Public profile detected — content could not be verified from this session. (LinkedIn)',
      )
    }
  })

  it('never reports a refusal as an absence of signals', () => {
    const h = headline('login_required', 'Acme', 'LinkedIn')
    expect(h).not.toMatch(/no signal/i)
    expect(h).not.toMatch(/nothing found/i)
    expect(h).toContain('Public profile detected')
  })

  it('states the presence plainly when the platform did answer', () => {
    expect(headline('public', 'Acme', 'Facebook')).toBe('Acme publishes a Facebook profile on its own website.')
    expect(headline('metadata_only', 'Acme', 'Instagram')).toBe(
      'Acme publishes a Instagram profile on its own website.',
    )
  })
})
