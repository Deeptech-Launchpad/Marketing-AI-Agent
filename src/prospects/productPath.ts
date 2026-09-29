// WHICH ADDRESSES ARE NEVER ONE PRODUCT'S PAGE.
//
// Moved unchanged out of productPageAnalysis.ts (2026-09-28) so Outreach
// judges a product page link by exactly the rule Prospects uses, rather than
// a second copy that could drift from it.

/**
 * Path segments that name something other than one product. A page under
 * /solutions/ or /faq/ is that, whatever product words its title uses.
 */
const NON_PRODUCT_SEGMENT =
  /^(solutions?|industr(y|ies)|applications?|markets?|sectors?|blogs?|news|articles?|stories|faqs?|help|resources?|support|learn(ing)?|insights?|guides?|case-stud(y|ies)|about(-us)?|company|careers?|jobs|events?|press|media|knowledge(-base)?|training|services?|contact(-us)?|webinars?|videos?|downloads?|literature|brochures?|catalogs?|catalogues?|search|cart|account|login|privacy|terms|legal|sitemap|categories|category|collections?|brands?|shop-by|compare|wishlist)$/i

/** Files and upload folders: a PDF or an image is never the product page. */
const FILE_PATH = /(\.(pdf|jpe?g|png|gif|webp|svg|zip|docx?|xlsx?|pptx?|mp4|mov)$)|\/(wp-content|uploads|media|assets|static)\//i

/**
 * Words that mark a page as something other than a product wherever they
 * appear in a segment: "a2z_crescent-contest_landing-page", "recall",
 * "news-release-details", "newsroom".
 */
const NON_PRODUCT_WORD =
  /(contest|sweepstake|giveaway|landing[-_]?page|recalls?\b|news[-_]?releases?|press[-_]?releases?|newsroom|investors?\b|warranty|registration|rebates?\b|promotions?\b|coupons?\b)/i

/** Side sites of a company that never carry its product pages. */
const NON_PRODUCT_HOST = /^(newsroom|pressroom|press|news|media|ir|investors?|careers?|jobs|blog|community|events)\./i

export function nonProductPath(url: string): boolean {
  try {
    const u = new URL(url)
    if (NON_PRODUCT_HOST.test(u.hostname.replace(/^www\./i, ''))) return true
    const path = u.pathname
    if (FILE_PATH.test(path)) return true
    return path
      .split('/')
      .filter(Boolean)
      .some((seg) => {
        const s = decodeURIComponent(seg)
        return NON_PRODUCT_SEGMENT.test(s) || NON_PRODUCT_WORD.test(s)
      })
  } catch {
    return true
  }
}
