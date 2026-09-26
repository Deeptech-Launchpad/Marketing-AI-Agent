import { logger } from '../platform/logger.js'
import { fetchAsset } from '../research/pageFetch.js'

// Fetching the customer's own product images for the report.
//
// The audit records the image URL; the PDF needs the bytes. This is the only
// place that turns one into the other.
//
// THE URL IS NOT OURS. It is `product.image` as read verbatim off the audited
// page, so whoever controls that website controls what this function is asked
// to request. That makes this the one outbound call in the codebase pointed at
// an address a stranger chose — every other bare `fetch` in src/ goes to an
// operator-configured API base — and it is why it goes through the shared
// guarded transport rather than calling `fetch` itself.
//
// It used to call `fetch(url)` directly. It checked the protocol of the URL it
// was GIVEN, and then let fetch follow up to twenty redirects with no further
// check, which is the plainest form of SSRF there is: an image URL that 302s
// to http://169.254.169.254/ or to a service on the report host's own loopback
// is a request that leaves the building. The content-type test stopped the
// BYTES being embedded in a PDF; it never stopped the REQUEST. The size cap
// had the matching hole — `content-length` is absent on a chunked response, so
// `Number(null ?? '0')` passed the check at zero and the whole body was
// buffered by arrayBuffer() before anything measured it.
//
// fetchAsset closes both, and it exists precisely for this: one request in
// which the type check and the download are the same fetch, `assertPublicHost`
// re-run on every hop, a redirect cap, and the byte limit enforced against the
// stream rather than against a header the server writes.
//
// What has NOT changed: a URL that fails for any reason still yields no bytes,
// and the renderer still prints "No product image published on this page".
// That sentence is the honest outcome and the only one — there is no
// placeholder image, and a blocked fetch must never become a broken frame or a
// stock photograph in a document going to a customer.

/** pdfkit decodes JPEG and PNG. Anything else is left out rather than handed to it to fail on. */
const PDFKIT_IMAGE_TYPES = /^image\/(jpeg|jpg|png)$/

const MAX_BYTES = 4 * 1024 * 1024

/** Fetches what it can. Never throws; a missing image is a normal outcome. */
export async function fetchProductImages(urls: Array<string | null | undefined>): Promise<Map<string, Buffer>> {
  const wanted = [...new Set(urls.filter((u): u is string => typeof u === 'string' && u.length > 0))]
  const out = new Map<string, Buffer>()

  await Promise.all(
    wanted.map(async (url) => {
      // Keyed by the URL as OBSERVED, whatever the transport redirected to,
      // because that is the key the renderer looks the bytes up by. Nothing
      // about the stored audit evidence is rewritten here.
      try {
        const asset = await fetchAsset(url, {
          allowedTypes: PDFKIT_IMAGE_TYPES,
          maxBytes: MAX_BYTES,
          // No scheme downgrade: an image the page published over https must
          // not arrive over http because a redirect said so. An image the page
          // genuinely publishes over http still loads — the rule is "never
          // weaker than what the page itself published", not "https or
          // nothing", which would drop a real image and make the report state
          // that a published image was not published.
          httpsOnly: !url.trim().toLowerCase().startsWith('http://'),
        })

        if (!asset.ok || !asset.bytes || asset.bytes.byteLength === 0) {
          logger.info(
            {
              url,
              // An allowed 200 that carried nothing has no failure reason of
              // its own; saying so beats logging `reason: null`.
              reason: asset.reason ?? 'the response carried no bytes',
              status: asset.status,
              contentType: asset.contentType,
            },
            'product image not fetched; the report will state it is absent',
          )
          return
        }

        out.set(url, asset.bytes)
      } catch (err) {
        // assertPublicHost throws BlockedAddressError rather than returning,
        // so a blocked destination lands here. It is a normal outcome for an
        // address we were never going to be allowed to reach, and it must not
        // take down a report generation.
        logger.info(
          { url, err: (err as Error).message },
          'product image not fetched; the report will state it is absent',
        )
      }
    }),
  )

  return out
}
