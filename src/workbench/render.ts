import { env } from '../config/env.js'
import { EMPTY_STATE, NEUTRAL_THEME, type ComparedField, type ThemeProfile, type ValuePoint } from './types.js'

// TASK #981 — the customer-facing page.
//
// A prospect should understand this in ten to fifteen seconds: here is your
// product today, here is what it could be, here is why it matters, here is a
// fifteen-minute conversation. Everything else is secondary.
//
// SECURITY: the page ships with NO JavaScript and a CSP with no script-src.
// Every value on it originates from a third-party website, so rather than
// filtering script injection, there is no script execution context at all —
// an injected <script> is inert because scripts cannot run, and it is escaped
// anyway. Theme tokens were format-validated upstream; text is escaped here.

/** The single escape used for every value that reaches the page. */
export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The Content-Security-Policy for the public Workbench.
 *
 * No script-src at all, so nothing executes. Images are limited to our own
 * origin and data: URIs — a prospect logo is proxied through us rather than
 * hotlinked, so their server never sees a customer's IP either.
 */
export const PUBLIC_CSP =
  "default-src 'none'; " +
  "style-src 'unsafe-inline'; " +
  "img-src 'self' data:; " +
  "form-action 'self'; " +
  "base-uri 'none'; " +
  "frame-ancestors 'none'"

export interface RenderInput {
  companyName: string
  websiteUrl: string | null
  productName: string | null
  productPageUrl: string | null
  theme: ThemeProfile
  fields: ComparedField[]
  valuePoints: ValuePoint[]
  structuredData: Record<string, unknown> | null
  observedFieldCount: number
  totalFieldCount: number
  improvedFieldCount: number
  auditDate: string
  /** Present once a visitor has registered. */
  visitorName?: string | null
  /** Proxy path for the prospect logo, when one was safely sampled. */
  logoPath?: string | null
  showEvidence: boolean
  /**
   * The link token, so panel and CTA links stay inside this demonstration.
   *
   * TASK #983: this page carries no JavaScript and a CSP with no script-src,
   * which is a property worth keeping. So the only acts the server can honestly
   * observe are real navigations, and these links are what make one possible.
   */
  token?: string
  /**
   * Which panel the visitor asked to focus on, taken from the query string.
   *
   * `both` is the default arrival view and is not itself a focus act — landing
   * on the page is already `workbench_viewed`.
   */
  panel?: 'before' | 'after' | 'both'
}

function styles(t: ThemeProfile): string {
  // Theme values were validated in themeExtractor (hex literals and allowlisted
  // font families only), so nothing attacker-controlled reaches this CSS.
  return `
:root{
  --primary:${t.primary};--accent:${t.accent};--ink:${t.ink};--surface:${t.surface};
  --muted:${t.muted};--radius:${t.radius};--font:${t.fontFamily};--heading:${t.headingFamily};
  --line:#e5e7eb;--wash:#f8fafc;--good:#047857;--gap:#b45309;
}
*{box-sizing:border-box}
body{margin:0;background:var(--wash);color:var(--ink);font-family:var(--font);line-height:1.55;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header.bar{background:var(--primary);color:#fff;padding:14px 0}
header.bar .wrap{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header.bar img{height:30px;width:auto;background:#fff;padding:4px 8px;border-radius:6px}
header.bar .who{font-weight:700;font-size:15px}
header.bar .tag{margin-left:auto;font-size:12px;opacity:.85}
.hero{padding:44px 0 28px}
.hero h1{font-family:var(--heading);font-size:32px;line-height:1.2;margin:0 0 10px}
.hero p.sub{font-size:17px;color:#374151;margin:0 0 18px;max-width:64ch}
.chip{display:inline-block;background:#fff;border:1px solid var(--line);border-radius:999px;
  padding:5px 12px;font-size:12px;color:var(--muted);margin:0 6px 6px 0}
.compare{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin:8px 0 34px}
@media(max-width:760px){.compare{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);overflow:hidden}
.panel.after{border-color:var(--accent);box-shadow:0 2px 14px rgba(0,0,0,.06)}
.panel h2{margin:0;padding:13px 18px;font-family:var(--heading);font-size:13px;letter-spacing:.08em;
  text-transform:uppercase;border-bottom:1px solid var(--line);background:var(--wash)}
.panel.after h2{background:var(--accent);color:#fff;border-bottom-color:var(--accent)}
.pname{padding:16px 18px 6px;font-family:var(--heading);font-size:19px;font-weight:700}
dl{margin:0;padding:6px 18px 18px}
dt{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:12px 0 2px}
dd{margin:0;font-size:15px;word-break:break-word}
dd.empty{color:#9ca3af;font-style:italic;font-size:13px}
dd.new{color:var(--good);font-weight:600}
.badge{display:inline-block;font-size:10px;letter-spacing:.05em;text-transform:uppercase;
  padding:2px 7px;border-radius:999px;margin-left:7px;vertical-align:1px}
.badge.add{background:#ecfdf5;color:var(--good)}
.badge.re{background:#eff6ff;color:#1d4ed8}
.badge.miss{background:#fffbeb;color:var(--gap)}
h3.sec{font-family:var(--heading);font-size:21px;margin:34px 0 14px}
.values{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:14px;margin-bottom:34px}
.value{background:var(--surface);border:1px solid var(--line);border-left:3px solid var(--accent);
  border-radius:var(--radius);padding:16px 18px}
.value h4{margin:0 0 6px;font-family:var(--heading);font-size:15px}
.value p{margin:0;font-size:14px;color:#374151}
.cta{background:var(--primary);color:#fff;border-radius:var(--radius);padding:28px 30px;margin:8px 0 34px}
.cta h3{margin:0 0 8px;font-family:var(--heading);font-size:22px}
.cta p{margin:0 0 18px;font-size:15px;opacity:.92;max-width:60ch}
.cta a{display:inline-block;background:#fff;color:var(--primary);text-decoration:none;font-weight:700;
  padding:13px 24px;border-radius:8px;font-size:15px}
.focus{display:flex;gap:10px;flex-wrap:wrap;margin:0 0 14px;font-size:13px;align-items:center}
.focus span.lbl{color:var(--muted)}
.focus a{display:inline-block;padding:7px 14px;border:1px solid var(--line);border-radius:999px;
  text-decoration:none;color:var(--muted);background:var(--surface)}
.focus a.on{background:var(--primary);color:#fff;border-color:var(--primary);font-weight:600}
.evlink{display:inline-block;margin:0 0 34px;font-size:13px;color:var(--muted)}
details{margin:0 0 34px;font-size:13px}
summary{cursor:pointer;color:var(--muted);padding:8px 0}
table.ev{width:100%;border-collapse:collapse;margin-top:10px;font-size:12px}
table.ev th,table.ev td{border:1px solid var(--line);padding:7px 9px;text-align:left;vertical-align:top}
table.ev th{background:var(--wash);font-weight:600}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;word-break:break-all}
footer{border-top:1px solid var(--line);padding:20px 0 40px;font-size:12px;color:var(--muted)}
form.reg{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);
  padding:26px 28px;max-width:520px}
form.reg label{display:block;font-size:12px;color:var(--muted);margin:14px 0 4px;font-weight:600}
form.reg input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:8px;
  font-size:15px;font-family:var(--font)}
form.reg button{margin-top:20px;background:var(--primary);color:#fff;border:0;border-radius:8px;
  padding:13px 26px;font-size:15px;font-weight:700;cursor:pointer;font-family:var(--font)}
.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:11px 14px;border-radius:8px;
  font-size:14px;margin-bottom:14px}
`.trim()
}

function shell(title: string, theme: ThemeProfile, body: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>${esc(title)}</title>
<style>${styles(theme)}</style>
</head><body>
${body}
</body></html>`
}

function header(input: { companyName: string; logoPath?: string | null }): string {
  return `<header class="bar"><div class="wrap">
${input.logoPath ? `<img src="${esc(input.logoPath)}" alt="">` : ''}
<span class="who">${esc(input.companyName)}</span>
<span class="tag">Product Data Health Check &middot; AltiusNXT</span>
</div></header>`
}

/** The strongest fields, in the panel order a buyer reads. */
function panelFields(fields: ComparedField[], side: 'before' | 'after'): string {
  const shown = fields.filter((f) => f.headline || (side === 'after' && f.delta === 'added'))

  return shown
    .map((f) => {
      const value = side === 'before' ? f.before : f.after
      if (!value) {
        return `<dt>${esc(f.label)}</dt><dd class="empty">${esc(EMPTY_STATE)}</dd>`
      }
      const badge =
        side === 'after' && f.delta === 'added'
          ? '<span class="badge add">Added</span>'
          : side === 'after' && f.delta === 'restructured'
            ? '<span class="badge re">Structured</span>'
            : side === 'after' && f.delta === 'reworded'
              ? '<span class="badge re">Rewritten</span>'
              : ''
      const cls = side === 'after' && (f.delta === 'added' || f.delta === 'reworded') ? ' class="new"' : ''
      return `<dt>${esc(f.label)}${badge}</dt><dd${cls}>${esc(truncate(value, 400))}</dd>`
    })
    .join('\n')
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** The registration gate. A plain form POST — no JavaScript needed. */
export function renderRegistration(input: {
  companyName: string
  theme: ThemeProfile
  token: string
  productName: string | null
  logoPath?: string | null
  error?: string | null
  values?: Record<string, string>
}): string {
  const v = input.values ?? {}
  const body = `
${header(input)}
<div class="wrap">
  <div class="hero">
    <h1>See what we found in your product experience.</h1>
    <p class="sub">We reviewed a sample of pages on ${esc(input.companyName)}'s website${
      input.productName ? ` — including <strong>${esc(input.productName)}</strong>` : ''
    }. Tell us who you are and the interactive comparison opens straight away.</p>
  </div>
  <form class="reg" method="POST" action="/workbench/${esc(input.token)}/register">
    ${input.error ? `<div class="err">${esc(input.error)}</div>` : ''}
    <label for="fullName">Full name</label>
    <input id="fullName" name="fullName" required maxlength="120" autocomplete="name" value="${esc(v.fullName ?? '')}">
    <label for="companyName">Company</label>
    <input id="companyName" name="companyName" required maxlength="160" autocomplete="organization" value="${esc(v.companyName ?? input.companyName)}">
    <label for="workEmail">Work email</label>
    <input id="workEmail" name="workEmail" type="email" required maxlength="200" autocomplete="email" value="${esc(v.workEmail ?? '')}">
    <label for="jobTitle">Job title <span style="font-weight:400">(optional)</span></label>
    <input id="jobTitle" name="jobTitle" maxlength="120" autocomplete="organization-title" value="${esc(v.jobTitle ?? '')}">
    <label for="phone">Phone <span style="font-weight:400">(optional)</span></label>
    <input id="phone" name="phone" maxlength="40" autocomplete="tel" value="${esc(v.phone ?? '')}">
    <button type="submit">Open my product review</button>
  </form>
  <footer>Your details are used to give you access to this review. AltiusNXT &middot; noindex</footer>
</div>`
  return shell(`See what we found — ${input.companyName}`, input.theme, body)
}

/** The Workbench itself. */
export function renderWorkbench(input: RenderInput): string {
  const added = input.fields.filter((f) => f.delta === 'added')
  const restructured = input.fields.filter((f) => f.delta === 'restructured')
  const absent = input.fields.filter((f) => f.delta === 'still_absent')
  const panel = input.panel ?? 'both'

  const body = `
${header(input)}
<div class="wrap">
  <div class="hero">
    ${input.visitorName ? `<div class="chip">Welcome, ${esc(input.visitorName)}</div>` : ''}
    <h1>Your product page today, and what it could be.</h1>
    <p class="sub">This is a real product page from ${esc(input.companyName)}'s website, reviewed on ${esc(
      input.auditDate,
    )}. Everything on the left is what we actually found. Everything on the right is built from that same evidence — nothing has been invented.</p>
    <div>
      <span class="chip">${input.observedFieldCount} of ${input.totalFieldCount} product fields published today</span>
      ${added.length ? `<span class="chip">${added.length} field(s) recoverable from your own page</span>` : ''}
      ${restructured.length ? `<span class="chip">${restructured.length} field(s) made machine-readable</span>` : ''}
    </div>
  </div>

  ${focusControls(input)}

  <div class="compare"${panel === 'both' ? '' : ' style="grid-template-columns:1fr"'}>
    ${
      panel === 'after'
        ? ''
        : `<section class="panel">
      <h2>Before &middot; your page today</h2>
      <div class="pname">${esc(input.productName ?? 'Selected product')}</div>
      <dl>${panelFields(input.fields, 'before')}</dl>
    </section>`
    }
    ${
      panel === 'before'
        ? ''
        : `<section class="panel after">
      <h2>After &middot; improved from your own evidence</h2>
      <div class="pname">${esc(input.productName ?? 'Selected product')}</div>
      <dl>${panelFields(input.fields, 'after')}</dl>
    </section>`
    }
  </div>

  ${
    input.valuePoints.length
      ? `<h3 class="sec">Why this matters</h3>
  <div class="values">
  ${input.valuePoints
    .map((p) => `<div class="value"><h4>${esc(p.title)}</h4><p>${esc(p.why)}</p></div>`)
    .join('\n')}
  </div>`
      : ''
  }

  <div class="cta">
    <h3>Want to see what this could look like across your wider catalogue?</h3>
    <p>This review covered one product page. A short walkthrough shows what the same approach would mean for the rest of your range${
      absent.length ? `, starting with the ${absent.length} field(s) not published on this page today` : ''
    }.</p>
    <a href="${esc(ctaHref(input))}" rel="noopener noreferrer">${esc(env.WORKBENCH_CTA_LABEL)}</a>
  </div>

  ${input.showEvidence ? evidenceSection(input) : ''}

  <footer>
    Styled to reflect ${esc(input.companyName)}'s existing product experience. This is an illustrative comparison
    prepared by AltiusNXT, not a copy of the live website.
    ${input.productPageUrl ? `<br>Source page: <code>${esc(input.productPageUrl)}</code>` : ''}
  </footer>
</div>`

  return shell(`${input.companyName} — Product Data Health Check`, input.theme, body)
}

/**
 * The CTA destination.
 *
 * TASK #983: when a token is present the link goes through our own server,
 * which records the click and then redirects to the real booking page. Without
 * a token it is the plain external URL — a click there is simply not observed,
 * which is preferable to guessing that one happened.
 */
function ctaHref(input: RenderInput): string {
  return input.token ? `/workbench/${encodeURIComponent(input.token)}/cta` : env.WORKBENCH_CTA_URL
}

/**
 * Panel focus controls.
 *
 * Plain links, so they work with no JavaScript and each one is a navigation the
 * server sees. Using them is the comparison behaviour; a visitor who reads both
 * panels side by side without clicking generates no focus event, and that is
 * the honest outcome rather than an inferred one.
 */
function focusControls(input: RenderInput): string {
  if (!input.token) return ''
  const base = `/workbench/${encodeURIComponent(input.token)}`
  const panel = input.panel ?? 'both'
  const link = (value: 'both' | 'before' | 'after', label: string): string =>
    `<a class="${panel === value ? 'on' : ''}" href="${esc(value === 'both' ? base : `${base}?panel=${value}`)}">${esc(
      label,
    )}</a>`

  return `<div class="focus">
    <span class="lbl">Compare:</span>
    ${link('both', 'Side by side')}
    ${link('before', 'Your page today')}
    ${link('after', 'What it could be')}
  </div>`
}

/**
 * The source evidence.
 *
 * With a token this is a link to a server-rendered page, so opening it is an
 * observable act. Without one it stays the original inline `<details>`
 * disclosure — a browser opening a `<details>` element is invisible to the
 * server, and claiming otherwise would be inventing an observation.
 */
function evidenceSection(input: RenderInput): string {
  if (!input.token) return evidenceTable(input)
  return `<a class="evlink" href="/workbench/${encodeURIComponent(input.token)}/evidence">View source evidence &rarr;</a>`
}

/** The optional "View source evidence" disclosure. */
function evidenceTable(input: RenderInput): string {
  const rows = input.fields
    .filter((f) => f.provenance.sourceObservationId || f.delta !== 'unchanged')
    .map(
      (f) => `<tr>
<td>${esc(f.label)}</td>
<td>${esc(f.delta)}</td>
<td>${esc(f.provenance.rule)}</td>
<td><code>${esc(f.provenance.sourcePath ?? '—')}</code></td>
<td><code>${esc(truncate(f.provenance.sourceFragment ?? '—', 160))}</code></td>
</tr>`,
    )
    .join('\n')

  return `<details><summary>View source evidence</summary>
<table class="ev">
<tr><th>Field</th><th>Change</th><th>How it was produced</th><th>Where on your page</th><th>Source fragment</th></tr>
${rows}
</table>
${
  input.structuredData
    ? `<p style="margin-top:14px;color:#6b7280">Structured data assembled from the fields above:</p>
<pre style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:8px;padding:12px;overflow-x:auto"><code>${esc(
        JSON.stringify(input.structuredData, null, 2),
      )}</code></pre>`
    : ''
}
</details>`
}

/**
 * The evidence, on its own page.
 *
 * TASK #983: this exists so that "the visitor looked at where our claims came
 * from" is something the server actually observes. It is the same table as the
 * inline disclosure, reached by a navigation instead of a `<details>` toggle.
 */
export function renderEvidencePage(input: RenderInput): string {
  const back = input.token ? `/workbench/${encodeURIComponent(input.token)}` : null
  const body = `
${header(input)}
<div class="wrap">
  <div class="hero">
    <h1>Where every value on this page came from.</h1>
    <p class="sub">Each row names the field, what changed, the rule that produced it, and the exact place on
    ${esc(input.companyName)}'s own page the value was read from. Nothing on the right-hand side of the comparison
    was invented; if a value is not here, it was not found.</p>
  </div>
  ${evidenceTable({ ...input, token: undefined })}
  ${back ? `<p><a class="evlink" href="${esc(back)}">&larr; Back to the comparison</a></p>` : ''}
  <footer>
    Prepared by AltiusNXT from a review of ${esc(input.companyName)}'s website on ${esc(input.auditDate)}.
    ${input.productPageUrl ? `<br>Source page: <code>${esc(input.productPageUrl)}</code>` : ''}
  </footer>
</div>`
  return shell(`Source evidence — ${input.companyName}`, input.theme, body)
}

/** Shown when the audit found no product page. Never a fabricated demo. */
export function renderNoProduct(input: {
  companyName: string
  theme: ThemeProfile
  reason: string
  logoPath?: string | null
}): string {
  const body = `
${header(input)}
<div class="wrap">
  <div class="hero">
    <h1>We could not build an interactive example for this site.</h1>
    <p class="sub">Your website audit did not contain a suitable product page for this interactive example.</p>
    <p class="sub" style="color:#6b7280;font-size:15px">${esc(input.reason)}</p>
  </div>
  <div class="cta">
    <h3>A deeper catalogue review would still be useful.</h3>
    <p>We can look at the parts of your catalogue that were not reachable from the public site and show you what we would find.</p>
    <a href="${esc(env.WORKBENCH_CTA_URL)}" rel="noopener noreferrer">Contact us for a deeper catalog review</a>
  </div>
  <footer>AltiusNXT &middot; noindex</footer>
</div>`
  return shell(`${input.companyName} — Product Data Health Check`, input.theme, body)
}

/** A link that is expired, revoked, exhausted or unknown. Says nothing more. */
export function renderLinkUnavailable(reason: string): string {
  const body = `
<div class="wrap">
  <div class="hero">
    <h1>This link is no longer available.</h1>
    <p class="sub">${esc(reason)}</p>
    <p class="sub" style="font-size:15px;color:#6b7280">If you were sent this by AltiusNXT, ask your contact for a new link.</p>
  </div>
  <footer>AltiusNXT &middot; noindex</footer>
</div>`
  return shell('Link unavailable', NEUTRAL_THEME, body)
}
