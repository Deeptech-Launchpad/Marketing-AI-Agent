# Page-reader comparison: existing reader vs hardened reader

Run on 2026-11-03 from a server-side **isolated test area** (not the production application folder), not from
the Marketing application. GET only, one request chain at a time (1 s pause between sites), nothing stored, no
database, no Gemini, no CRM, no campaign. Limits: 1 GB memory, 100% CPU, 10 s timeout, 1 MiB size cap, 3 redirects.

- **Existing reader** = production commit `44ed755` (`fetchPageRaw`, `fetch` transport).
- **Hardened reader** = feature branch `9c9cb10` (`fetchPageRaw`, pinned `node:http(s)` transport, per-hop port and
  address checks).
- The two code trees differ only in `src/research/{pageFetch,ssrfGuard,tlsChain,pageCapture}.ts`.
- Timings are not a fair speed test: the existing reader ran first, so DNS and CDN caches were cold for it.

## Result in one paragraph

All 20 company sites read the same way with both readers: same HTTP status (19 × 200, Freshworks 403 for both),
same redirect chain, same final URL, same content type, same page title, all 20 ending on HTTPS. 15 were byte-for-byte
identical; 5 differed by a few hundred bytes because the live page changed between the two runs or, for the two
pages longer than the cap (Schneider Electric, Atlassian), because the read stops at the cap on a chunk boundary.
The only deliberate behaviour change is that a non-standard port (anything but 80/443) is now refused before any
connection is attempted.

### 20 company sites

| # | Site | Old: status / bytes / redirects / ms | New: status / bytes / redirects / ms | Final URL same | Verdict |
|---|---|---|---|---|---|
| C01 | Microsoft | 200 / 177961 / 1 / 317 | 200 / 177961 / 1 / 157 | yes | identical |
| C02 | Apple | 200 / 253635 / 0 / 261 | 200 / 253635 / 0 / 37 | yes | identical |
| C03 | Siemens (bare domain, no www) | 200 / 310196 / 2 / 2270 | 200 / 310196 / 2 / 727 | yes | identical |
| C04 | TCS (plain http) | 200 / 438726 / 1 / 255 | 200 / 438726 / 1 / 1095 | yes | identical |
| C05 | Infosys | 200 / 149359 / 0 / 226 | 200 / 149359 / 0 / 74 | yes | identical |
| C06 | Wipro (bare domain) | 200 / 218896 / 1 / 2096 | 200 / 218402 / 1 / 1979 | yes | same page, size 218896 vs 218402 (live content varies) |
| C07 | HCLTech | 200 / 195720 / 0 / 1096 | 200 / 195720 / 0 / 855 | yes | identical |
| C08 | Bosch | 200 / 149937 / 0 / 603 | 200 / 149937 / 0 / 54 | yes | identical |
| C09 | Schneider Electric | 200 / 1063692 / 1 / 431 | 200 / 1064960 / 1 / 252 | yes | same page, size 1063692 vs 1064960 (live content varies) |
| C10 | Honeywell (plain http) | 200 / 161233 / 2 / 2915 | 200 / 161233 / 2 / 1352 | yes | identical |
| C11 | Shopify | 200 / 676190 / 0 / 156 | 200 / 676171 / 0 / 85 | yes | same page, size 676190 vs 676171 (live content varies) |
| C12 | Atlassian | 200 / 1064960 / 0 / 764 | 200 / 1061132 / 0 / 624 | yes | same page, size 1064960 vs 1061132 |
| C13 | Zoho (bare domain) | 200 / 17900 / 1 / 910 | 200 / 17900 / 1 / 792 | yes | identical |
| C14 | Freshworks | 403 / 0 / 0 / 185 — The site returned HTTP 403. | 403 / 0 / 0 / 31 — The site returned HTTP 403. | yes | identical |
| C15 | Tata Motors | 200 / 95013 / 0 / 798 | 200 / 95013 / 0 / 984 | yes | identical |
| C16 | Larsen & Toubro (plain http) | 200 / 219143 / 1 / 1062 | 200 / 219186 / 1 / 568 | yes | same page, size 219143 vs 219186 (live content varies) |
| C17 | Mahindra | 200 / 197821 / 0 / 189 | 200 / 197821 / 0 / 53 | yes | identical |
| C18 | Godrej | 200 / 9738 / 0 / 1728 | 200 / 9738 / 0 / 64 | yes | identical |
| C19 | Hindustan Unilever | 200 / 473978 / 0 / 281 | 200 / 473978 / 0 / 126 | yes | identical |
| C20 | ITC | 200 / 226805 / 1 / 593 | 200 / 226805 / 1 / 231 | yes | identical |

### Edge cases

| # | Site | Old: status / bytes / redirects / ms | New: status / bytes / redirects / ms | Final URL same | Verdict |
|---|---|---|---|---|---|
| E01 | Edge: expired certificate | – / 0 / 0 / 2157 — The site's TLS certificate has expired. | – / 0 / 0 / 466 — The site reset the connection. | yes | DIFFERENT |
| E02 | Edge: self-signed certificate | – / 0 / 0 / 8204 — The site's TLS certificate is self-signed. | – / 0 / 0 / 848 — The site's TLS certificate is self-signed. | yes | identical |
| E03 | Edge: wrong host name in certificate | – / 0 / 0 / 864 — The site's TLS certificate does not cover that hostname. | – / 0 / 0 / 1984 — The site reset the connection. | yes | DIFFERENT |
| E04 | Edge: incomplete certificate chain | – / 0 / 0 / 1784 — The site's TLS certificate chain is incomplete and could not be verif… | – / 0 / 0 / 9259 — The site reset the connection. | yes | DIFFERENT |
| E05 | Edge: non-standard port (8443) | – / 0 / 0 / 10006 — The site took too long to respond. | – / 0 / 0 / 0 — That port is not allowed: only ports 80 and 443 are read. | yes | DIFFERENT |
| E06 | Edge: loopback address | – / 0 / 0 / 0 — That address is not publicly reachable. | – / 0 / 0 / 0 — That address is not publicly reachable. | yes | identical |
| E07 | Edge: cloud metadata address | – / 0 / 0 / 1 — That address is not publicly reachable. | – / 0 / 0 / 0 — That address is not publicly reachable. | yes | identical |
| E08 | Edge: redirect chain (httpbin 3 hops) | 200 / 0 / 3 / 2296 | 200 / 0 / 3 / 5412 | yes | identical |
| E09 | Edge: redirect to private address | 403 / 0 / 0 / 287 — The site returned HTTP 403. | 403 / 0 / 0 / 1352 — The site returned HTTP 403. | yes | identical |
| E10 | Edge: HTML page larger than the size cap | 404 / 0 / 0 / 1523 — The site returned HTTP 404. | 404 / 0 / 0 / 2175 — The site returned HTTP 404. | yes | identical |


## Notes on the edge cases

- **Bad certificates (E01–E04):** both readers refuse expired, self-signed and wrong-host certificates with the same
  plain sentences. badssl.com resets connections at random from this server, which made single runs look different.
  Repeated 3 times on each reader: every non-reset answer was the same sentence for both; resets hit both readers.
  In the first table E01/E03/E04 show "The site reset the connection" for the hardened reader only because of such
  a reset; repeated runs gave the specific sentences.
- **Incomplete certificate chain (E04):** both readers share the same chain-completion retry. Results varied run to
  run for the hardened reader (the page was read in 2 of 6 attempts, and refused with "chain incomplete" in the rest);
  the existing reader refused in 4 of 4. That is not enough to claim an improvement. Neither is reliable on this site.
- **Port 8443 (E05):** existing reader tried to connect and gave up after 10 s ("took too long"); hardened reader
  refuses at once ("only ports 80 and 443 are read"). Intended.
- **Loopback and cloud-metadata addresses (E06, E07):** refused by both, no connection made.
- **Redirect to a private address (E09) and the oversized page (E10):** the live targets did not behave as hoped
  (httpbin answered 403, the spec page URL gave 404 for both readers), so these two were not exercised live. Both
  are covered by the unit suite (`ssrfHardening`, 49 tests). The size cap itself was exercised live by C09 and C12.
- **TLS facts (probed once from the server, 17 HTTPS sites plus the 3 http sites checked separately):** every company
  certificate verified; 18 on TLS 1.3 and 2 on TLS 1.2 (Wipro, HCLTech).

## Conclusion

No regression found on the company sites. The pass condition of the deployment plan (step b: same pages, same status class) is met.
Step c (edge cases) is met except the two live checks above, which rely on the unit tests.
