import 'dotenv/config'
import { z } from 'zod'

// Boot-time configuration. Everything is validated here and nowhere else, and
// a missing or malformed required value FAILS THE PROCESS rather than falling
// back to a placeholder. That is deliberate: NXT Sales defaults JWT_SECRET to
// the literal string 'dev-secret' in four places, which silently turns
// forgeable tokens into a production condition. This service does not repeat
// that pattern.

const bool = z
  .string()
  .transform((v) => v === 'true' || v === '1')
  .pipe(z.boolean())

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4100),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  MARKETING_DATABASE_URL: z.string().min(1, 'MARKETING_DATABASE_URL is required'),

  // Must be byte-identical to NXT Sales' JWT_SECRET: this service verifies the
  // tokens NXT Sales issues, and mints the service-account token it uses to
  // call back into the CRM.
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be set and at least 16 chars'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional().or(z.literal('')),

  NXT_SALES_BASE_URL: z.string().url(),
  NXT_SALES_SERVICE_USER_ID: z.string().default(''),
  NXT_SALES_SERVICE_USER_EMAIL: z.string().default('marketing-agent@service.local'),
  /**
   * The service identity CONFIRMED against live NXT Sales.
   *
   * Declared separately from NXT_SALES_SERVICE_USER_ID so the two can be
   * compared. Writing to a non-local host requires them to match, which is
   * what stops an agent write being stamped with a colleague's identity
   * because a base URL was repointed and an id was not.
   */
  NXT_SALES_LIVE_SERVICE_USER_ID: z.string().default(''),
  NXT_SALES_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  NXT_SALES_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),
  NXT_SALES_MAX_PAGES: z.coerce.number().int().positive().default(50),

  GEMINI_API_KEY: z.string().default(''),
  GEMINI_API_BASE: z.string().url().default('https://generativelanguage.googleapis.com/v1beta'),
  GEMINI_MODEL_REASONING: z.string().default(''),
  GEMINI_MODEL_CONTENT: z.string().default(''),
  GEMINI_MODEL_EMBEDDING: z.string().default('gemini-embedding-001'),
  // The vector column is vector(768). Changing this after ingestion means
  // re-embedding the whole corpus, so it is validated against the column width.
  GEMINI_EMBEDDING_DIMENSIONS: z.coerce.number().int().default(768),
  // 60s, deliberately NOT the 12s used by NXT Sales' browser-side helper.
  // That value bounds a call a user is waiting on in a tab. These are
  // background agent steps, and content generation asks for several assets with
  // multiple variants in one structured response — at 12s every candidate model
  // times out and the step fails with "tried 5 models" even though nothing is
  // actually wrong. Step-level and budget limits still bound the run overall.
  GEMINI_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  GEMINI_MAX_CONCURRENCY: z.coerce.number().int().positive().default(4),

  BUDGET_MAX_TOKENS_PER_RUN: z.coerce.number().int().positive().default(500_000),
  BUDGET_MAX_USD_PER_RUN: z.coerce.number().positive().default(5),
  MAX_AUDIENCE_SIZE: z.coerce.number().int().positive().default(500),
  MAX_STEPS_PER_RUN: z.coerce.number().int().positive().default(30),
  MAX_RESEARCH_PAGES_PER_RUN: z.coerce.number().int().nonnegative().default(15),

  DEFAULT_RUN_MODE: z.literal('dry_run').default('dry_run'),
  KILL_SWITCH_ENABLED: bool.default('false'),
  ALLOW_SELF_APPROVAL: bool.default('false'),
  APPROVAL_TTL_HOURS: z.coerce.number().int().positive().default(168),

  SEARCH_API_PROVIDER: z.enum(['none']).default('none'),
  SEARCH_API_KEY: z.string().default(''),
  RESEARCH_USER_AGENT: z.string().default('MarketingAgent/1.0 (+contact via CRM administrator)'),
  RESEARCH_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(12_000),
  RESEARCH_MAX_BYTES: z.coerce.number().int().positive().default(2 * 1024 * 1024),
  RESEARCH_MAX_REDIRECTS: z.coerce.number().int().nonnegative().default(3),
  RESEARCH_CACHE_TTL_HOURS: z.coerce.number().int().positive().default(168),
  /**
   * How long a FAILED page read is remembered, in minutes.
   *
   * Much shorter than the success TTL on purpose. A page that was read is a
   * statement about content; a page that could not be read is a statement
   * about one moment — a reset connection, a rate limit, a certificate this
   * client could not verify at the time. Remembering that for a week means one
   * bad minute marks a company unreachable until the following week.
   */
  RESEARCH_FAILURE_CACHE_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  KNOWLEDGE_MAX_UPLOAD_CHARS: z.coerce.number().int().positive().default(400_000),
  // Minimum cosine similarity for a vector hit to count as a match.
  //
  // Without a floor, retrieval returns its top-N for ANY query: asking the
  // knowledge base about sourdough bread returns product and brand chunks with
  // ordinary-looking scores, and the step that called it treats them as
  // relevant context. The keyword arm needs no floor because plainto_tsquery
  // ANDs its terms and simply matches nothing.
  //
  // PROVISIONAL VALUE. Measured against the synthetic fixture corpus, relevant
  // queries scored 0.587-0.675 and irrelevant ones peaked at 0.514 - a gap of
  // only ~0.07, because gemini-embedding-001 at 768 dimensions produces a
  // compressed similarity range. This must be re-tuned against the real corpus
  // before production; run scripts/retrieval-report.mjs to see the current
  // distribution.
  KNOWLEDGE_MIN_COSINE: z.coerce.number().min(0).max(1).default(0.55),

  // ── Stage 3: intent detection ───────────────────────────────────────────
  APIFY_TOKEN: z.string().default(''),
  APIFY_JOBS_ACTOR: z.string().default('misceres~indeed-scraper'),
  // Hard per-company ceiling. The jobs Actor bills per returned listing, so
  // this bounds the spend of a single collection to a known number.
  APIFY_MAX_RESULTS_PER_COMPANY: z.coerce.number().int().positive().max(50).default(10),
  APIFY_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  // Whether the configured Actor can actually scope a search to ONE company.
  //
  // misceres~indeed-scraper cannot: `company` is not a declared input, and
  // passing it is silently ignored — a search for "Grainger" returned Heraeus
  // and D. E. Shaw. Since the provider then discards every off-employer result,
  // running it would pay per listing for a guaranteed-zero outcome. Left false
  // until an Actor that supports company scoping is configured.
  APIFY_JOBS_COMPANY_SCOPED: bool.default('false'),
  // Freshness thresholds in days. Intent is time-sensitive: a two-year-old job
  // posting is not evidence of current need.
  INTENT_FRESH_DAYS: z.coerce.number().int().positive().default(30),
  INTENT_AGING_DAYS: z.coerce.number().int().positive().default(90),
  // No infinite retries against a paid provider.
  INTENT_MAX_RETRIES: z.coerce.number().int().positive().max(10).default(3),
  // Live monitoring (2026-09-29): the same Intent Signals run, repeated on a
  // schedule for companies already being worked, so new public discussions,
  // news and reviews are picked up after deployment. Off by default — every
  // run spends search and model budget. The same filters apply; a signal seen
  // again is refreshed, never duplicated.
  INTENT_MONITOR_ENABLED: bool.default('false'),
  /** How often the monitor wakes (hours). */
  INTENT_MONITOR_INTERVAL_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** A company is re-checked at most this often (days). */
  INTENT_MONITOR_MIN_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  /** At most this many companies are re-checked per wake-up, oldest first. */
  INTENT_MONITOR_MAX_COMPANIES: z.coerce.number().int().min(1).max(100).default(10),

  // ── Stage 4: decision-maker discovery ───────────────────────────────────
  //
  // NONE of these person-data credentials exist in this environment. They are
  // declared so that acquiring a subscription is a config change rather than a
  // code change: each adapter is written against its real API and reports
  // `unauthorized` with a precise reason until its key is present.
  APOLLO_API_KEY: z.string().default(''),
  APOLLO_API_BASE: z.string().url().default('https://api.apollo.io/api/v1'),
  ZOOMINFO_USERNAME: z.string().default(''),
  ZOOMINFO_PASSWORD: z.string().default(''),
  ZOOMINFO_CLIENT_ID: z.string().default(''),
  ZOOMINFO_PRIVATE_KEY: z.string().default(''),
  ZOOMINFO_API_BASE: z.string().url().default('https://api.zoominfo.com'),
  ROCKETREACH_API_KEY: z.string().default(''),
  ROCKETREACH_API_BASE: z.string().url().default('https://api.rocketreach.co/api/v2'),
  // LinkedIn person data requires an approved Partner Program application.
  // A scraper is NOT a substitute: it obtains the same data by violating the
  // platform's terms, which the Stage 4 access rules explicitly prohibit.
  LINKEDIN_ACCESS_TOKEN: z.string().default(''),
  LINKEDIN_API_BASE: z.string().url().default('https://api.linkedin.com/v2'),

  // ── Email verification (Team Answer, Section 4) ───────────────────────
  // The document names Hunter.io and Verifalia. Both adapters are built; each
  // reports `not_configured` until a credential exists, and no address is
  // treated as outreach-ready in the meantime.
  //
  // Leave EMAIL_VERIFICATION_PROVIDER unset to try whichever is configured.
  EMAIL_VERIFICATION_PROVIDER: z.enum(['hunter', 'verifalia', '']).default(''),
  HUNTER_API_KEY: z.string().default(''),
  HUNTER_API_BASE: z.string().url().default('https://api.hunter.io'),
  VERIFALIA_USERNAME: z.string().default(''),
  VERIFALIA_PASSWORD: z.string().default(''),
  VERIFALIA_API_BASE: z.string().url().default('https://api.verifalia.com'),
  EMAIL_VERIFICATION_TIMEOUT_MS: z.coerce.number().int().positive().max(60_000).default(15_000),

  // ── Regional job boards (Team Answer, Section D.1) ────────────────────
  // One collector Actor per board. An unset board is reported as
  // `not_configured` and contributes nothing — never as "no hiring activity".
  //
  // LINKEDIN_JOBS_ACTOR exists for completeness only: the board is blocked by
  // policy regardless of its value, because collecting LinkedIn through a
  // third-party scraper is the workaround the provider policy prohibits.
  APIFY_SEEK_ACTOR: z.string().default(''),
  APIFY_PNET_ACTOR: z.string().default(''),
  APIFY_CAREERS24_ACTOR: z.string().default(''),
  APIFY_BAYT_ACTOR: z.string().default(''),
  APIFY_GULFTALENT_ACTOR: z.string().default(''),
  APIFY_JOBSTREET_ACTOR: z.string().default(''),
  APIFY_JOBSDB_ACTOR: z.string().default(''),
  LINKEDIN_JOBS_ACTOR: z.string().default(''),

  /** Shortlist cap. The spec asks for 3-5; fewer is a valid outcome. */
  DM_MAX_CANDIDATES: z.coerce.number().int().positive().max(25).default(5),
  /** Pages of a company's own site read per discovery, bounding the crawl. */
  DM_MAX_PAGES_PER_COMPANY: z.coerce.number().int().positive().max(20).default(6),
  DM_MAX_RETRIES: z.coerce.number().int().positive().max(10).default(3),
  /**
   * Whether to persist emails/phones a provider returns. Default OFF: this
   * stage identifies WHO to talk to, and does not need contact details to do
   * it. Storing personal contact data has consequences that outlive the run.
   */
  DM_STORE_CONTACT_DATA: bool.default('false'),
  /**
   * Let a model READ the team pages this engine already fetched.
   *
   * Off by default. It never supplies a fact: every name and title it returns
   * is checked against the fetched bytes and dropped if absent, so the worst a
   * bad run can do is find nothing. See decisionmakers/modelReader.ts.
   */
  DM_MODEL_READER_ENABLED: bool.default('false'),
  /**
   * The public web research layer, shared by Decision Makers and Intent.
   *
   * Off by default because it spends money and reaches third-party hosts. It
   * changes what is DISCOVERED, never what is believed: a page found this way
   * is fetched through the same guarded transport and read by the same
   * verifier as a page found on the company's own domain, so turning it on
   * cannot weaken any existing guarantee. See research/publicResearch.ts.
   */
  PUBLIC_RESEARCH_ENABLED: bool.default('false'),
  /**
   * Reddit's official API, for reading the Reddit threads Intent Signals'
   * community-questions source finds (2026-09-26). Reddit refuses anonymous
   * reads, so without these the threads are skipped and the run says so.
   * Create a "script" app at reddit.com/prefs/apps; application-only access,
   * read-only, public posts only.
   */
  REDDIT_CLIENT_ID: z.string().optional(),
  REDDIT_CLIENT_SECRET: z.string().optional(),
  /** How many discovered URLs one company's research may consider. */
  PUBLIC_RESEARCH_MAX_SOURCES: z.coerce.number().int().positive().max(10).default(6),
  /** How many of those may actually be fetched. Bounds third-party traffic. */
  PUBLIC_RESEARCH_MAX_PAGES: z.coerce.number().int().nonnegative().max(10).default(4),
  /**
   * Decision Makers' own budget for the open web (2026-09-29): how many of the
   * pages its four people-searches find are fetched and read. The shared
   * budget above left about one page per search, too few to find a person the
   * company's own site does not list. Each page is one model read.
   */
  DM_PUBLIC_RESEARCH_MAX_PAGES: z.coerce.number().int().positive().max(10).default(8),
  /**
   * Open-web company discovery (2026-09-24 restructure) — "Find New Company"
   * in Prospects. Off by default, same reasoning as PUBLIC_RESEARCH_ENABLED:
   * it spends money and reaches third-party hosts. Every candidate it
   * produces is still read through the same guarded transport and the same
   * grounding discipline as everything else this platform fetches. See
   * prospects/companyWebDiscovery.ts.
   */
  COMPANY_WEB_DISCOVERY_ENABLED: bool.default('false'),
  /**
   * Start decision-maker discovery automatically for NEW leads.
   *
   * The worker checks NXT Sales on a schedule for companies created within the
   * lookback window and queues one search for each company that has never had
   * one. Off by default: every search spends provider and model budget. It
   * reads the CRM only — nothing is written back. See decisionmakers/leadWatch.ts.
   */
  DM_AUTO_DISCOVER_ENABLED: bool.default('false'),
  /**
   * Photograph product pages with a headless Chrome for the PDP Enrichment
   * Report. Every request the browser makes is checked against the same
   * public-address rule as the crawler. See research/pageCapture.ts.
   */
  PAGE_CAPTURE_ENABLED: bool.default('false'),
  /**
   * What the Website Audit reads. `end_pdp` (the default) audits only the
   * product page recorded in the company's End PDP field. `website` runs the
   * earlier whole-site crawl, retained for a future full-website audit.
   */
  AUDIT_SCOPE: z.enum(['end_pdp', 'website']).default('end_pdp'),
  /** Chrome/Chromium binary. Empty means look in the usual install locations. */
  CHROME_PATH: z.string().default(''),
  /** Minutes between checks for new leads. */
  DM_AUTO_DISCOVER_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(59).default(5),
  /** Only companies created this recently count as new — bounds the first check. */
  DM_AUTO_DISCOVER_LOOKBACK_HOURS: z.coerce.number().int().min(1).max(168).default(24),
  /** Most searches one check may start, so a bulk import cannot spend the budget at once. */
  DM_AUTO_DISCOVER_MAX_PER_CHECK: z.coerce.number().int().min(1).max(25).default(5),
  /**
   * Fallback paths to try when a site's own navigation suggests no page that
   * introduces its people. Comma-separated; empty means use the built-in list.
   *
   * Configuration rather than code so the fallback can be tuned without a
   * deploy. It is the same for every company — nothing here is, or may become,
   * company-specific.
   */
  DM_TEAM_PAGE_PATHS: z
    .string()
    .default('')
    .transform((v) => (v.trim() ? v.split(',') : [])),

  // ── Stage 5: website audit ──────────────────────────────────────────────
  //
  // Every one of these binds. A crawl stops at whichever is reached first and
  // records which one it was, so a thin result is never mistaken for a thin
  // catalogue. Defaults are the values agreed for Stage 5.
  // Team Answer, Section F.1: "keep the standard cap at 10–15 pages for all
  // leads ... no need to raise to 100/200 pages." The default is the top of
  // the confirmed band; the maximum stays high so a deeper inspection can be
  // enabled per run for a high-priority prospect, which the same section
  // permits. Section C.5 leaves the exact figure open with the developer, so
  // it is configuration rather than a constant.
  AUDIT_MAX_PAGES_PER_COMPANY: z.coerce.number().int().positive().max(200).default(15),

  // ── Customer / courier report (Team Answer F.5, Phase 6 Section 19) ───
  // "from the 25–50 defective SKUs identified per audit, showcase only 2–5 as
  // before/after comparison samples; the exact number should be a
  // user-configurable setting (not fixed)". Default 3, bounded to the agreed
  // 2–5 band so a setting cannot quietly turn the teaser into the full list.
  REPORT_CUSTOMER_SAMPLE_COUNT: z.coerce.number().int().min(1).max(5).default(3),
  /** Key findings on page 1 of the customer report. The brief says 2–4. */
  REPORT_CUSTOMER_KEY_FINDINGS: z.coerce.number().int().min(1).max(4).default(3),
  /** Peer-comparison rows, when a peer audit exists at all. */
  REPORT_COMPARISON_ROWS: z.coerce.number().int().min(1).max(8).default(4),
  /**
   * Finding categories to lead with, most important first. Anything not named
   * still appears; this only decides what the customer report highlights.
   */
  REPORT_HIGHLIGHT_CATEGORIES: z
    .string()
    .default('specifications,attributes,identifiers,descriptions,consistency,structure,availability'),
  /** Shown on the report. Falls back to the Workbench CTA when unset. */
  /**
   * The legal disclaimer printed on every customer-facing report.
   *
   * Team Answer F.6: "final legal wording to be confirmed by legal/compliance
   * before go-live." It is therefore EMPTY by default and generation fails
   * closed without it — a placeholder that silently shipped on a document sent
   * to a prospect is exactly the failure that requirement exists to prevent.
   */
  REPORT_LEGAL_DISCLAIMER: z.string().default(''),
  /**
   * Development-only. Permits a customer report from an unapproved report and
   * without a configured disclaimer, for local work. Refused in production by
   * the assertion below, exactly as WORKBENCH_ALLOW_UNAPPROVED is.
   */
  REPORT_ALLOW_UNAPPROVED: bool.default('false'),
  REPORT_CTA_URL: z.string().default(''),
  REPORT_CTA_LABEL: z.string().default('Book a 15-minute walkthrough'),
  REPORT_BRAND_NAME: z.string().default('AltiusNXT'),
  REPORT_BRAND_LOGO_PATH: z.string().default('web/public/altiusnxt-logo.png'),
  /**
   * The "Prepared by" sign-off on the PDP Enrichment Report. Configuration, not
   * code: the report names whoever the business says prepares it, and never a
   * person this service invented.
   */
  REPORT_PREPARED_BY_NAME: z.string().default('AltiusNxt Digital Commerce Team'),
  REPORT_PREPARED_BY_ROLE: z.string().default(''),
  REPORT_PREPARED_BY_COMPANY: z.string().default('AltiusNxt Technologies Pvt Ltd'),
  REPORT_PREPARED_BY_PHONE: z.string().default(''),
  REPORT_PREPARED_BY_EMAIL: z.string().default(''),
  REPORT_PREPARED_BY_WEB: z.string().default('www.altiusnxt.com'),
  AUDIT_MAX_PRODUCT_PAGES: z.coerce.number().int().positive().max(100).default(20),
  AUDIT_MAX_CATEGORY_PAGES: z.coerce.number().int().positive().max(50).default(5),
  /** Total downloaded bytes per company. 15MB at the 2MB per-page cap. */
  AUDIT_MAX_BYTES_PER_COMPANY: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  /** Link depth from the homepage. 3 reaches home -> category -> product. */
  AUDIT_MAX_DEPTH: z.coerce.number().int().positive().max(10).default(3),
  AUDIT_MAX_RETRIES: z.coerce.number().int().positive().max(10).default(3),
  /** Bounds one run's wall clock so a slow site cannot hold a worker forever. */
  AUDIT_RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  // ── Task #981: AI Workbench ─────────────────────────────────────────────
  //
  // Public base URL the QR code and share links resolve to. Must be the
  // externally reachable origin, not the internal port.
  WORKBENCH_PUBLIC_BASE_URL: z.string().url().default('http://localhost:4100'),
  WORKBENCH_LINK_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  /** Bounds how long one registration session keeps access. */
  WORKBENCH_SESSION_TTL_DAYS: z.coerce.number().int().positive().max(90).default(7),
  /** The 15-minute walkthrough CTA. A configured URL is the whole integration. */
  WORKBENCH_CTA_URL: z.string().url().default('https://altiusnxt.com/book-a-walkthrough'),
  WORKBENCH_CTA_LABEL: z.string().default('Book a 15-minute walkthrough'),
  /** Public requests per minute per IP, well below the internal API limit. */
  WORKBENCH_PUBLIC_RATE_LIMIT: z.coerce.number().int().positive().default(60),
  /**
   * DEVELOPMENT ONLY. Allows a Workbench to be built from a report that has
   * not been approved in Task #980.
   *
   * Refused outright when NODE_ENV is production — see the assertion below.
   * A customer-facing artifact built from an unreviewed report is exactly the
   * thing the approval workflow exists to prevent, so this cannot be a
   * production toggle, only a way to develop before an approval exists.
   */
  WORKBENCH_ALLOW_UNAPPROVED: bool.default('false'),

  // ── Task #982: multichannel outreach ────────────────────────────────────
  //
  // No outreach provider is configured in this environment. Each is declared
  // so that acquiring one is a config change rather than a rewrite, and each
  // adapter reports precisely why it cannot act until then.
  EMAIL_PROVIDER: z.enum(['none', 'smtp', 'sendgrid', 'postmark', 'ses', 'resend']).default('none'),
  OUTREACH_FROM_EMAIL: z.string().default(''),
  OUTREACH_FROM_NAME: z.string().default('AltiusNXT'),
  WHATSAPP_PROVIDER: z.enum(['none', 'meta_cloud', 'twilio']).default('none'),
  // Eligibility for an alternative channel is a business decision. Absent that
  // decision the default is off, not an invented 'high-value' threshold.
  OUTREACH_WHATSAPP_ENABLED: bool.default('false'),
  // internal = store a task in this platform for an SDR to pick up.
  OUTREACH_CALL_TASK_PROVIDER: z.string().default('internal'),

  /**
   * Whether the engine may perform an external action without a human
   * releasing it. Default FALSE everywhere: the platform composes, validates
   * and schedules, and a person presses send.
   */
  OUTREACH_AUTO_SEND: bool.default('false'),
  /** A rehearsal produces every artifact and performs no external action. */
  OUTREACH_DEFAULT_DRY_RUN: bool.default('true'),

  // Cadence, in days from the campaign start. Configurable, not hard-coded.
  OUTREACH_DAY_EMAIL_1: z.coerce.number().int().nonnegative().default(0),
  OUTREACH_DAY_LINKEDIN: z.coerce.number().int().nonnegative().default(2),
  OUTREACH_DAY_CALL: z.coerce.number().int().nonnegative().default(4),
  OUTREACH_DAY_EMAIL_2: z.coerce.number().int().nonnegative().default(7),
  OUTREACH_DAY_WHATSAPP: z.coerce.number().int().nonnegative().default(11),

  /** Days before the same company may be contacted by another campaign. */
  OUTREACH_COOLDOWN_DAYS: z.coerce.number().int().positive().max(365).default(30),
  OUTREACH_MAX_RETRIES: z.coerce.number().int().positive().max(10).default(3),
  /** Hard ceiling on one campaign, so a bug cannot become a mass send. */
  OUTREACH_MAX_ACTIONS_PER_CAMPAIGN: z.coerce.number().int().positive().max(50).default(10),

  // Required on every commercial message.
  OUTREACH_COMPANY_NAME: z.string().default('AltiusNXT'),
  OUTREACH_COMPANY_ADDRESS: z.string().default('address not configured'),

  // The Sales-approved email sequence (2026-09-26). Its day windows ("Day 9–10",
  // "within 1 business day") are counted in this time zone — the USA sequence
  // is worked from the US East Coast unless configured otherwise.
  OUTREACH_SEQUENCE_TIMEZONE: z.string().default('America/New_York'),

  // ── TEST MODE sending for the Sales sequence (2026-09-28) ──────────────
  // "off" (default): the platform sends nothing. "test": emails go ONLY to the
  // internal test inboxes below. There is deliberately no "live" value in this
  // phase — any other value fails validation and the service refuses to start,
  // so real customer sending cannot be switched on by configuration.
  OUTREACH_EMAIL_MODE: z.enum(['off', 'test']).default('off'),
  // The allow-list: exact addresses and/or "@domain" entries, comma-separated.
  // Every recipient is checked against it at the moment of sending.
  OUTREACH_TEST_RECIPIENTS: z.string().default(''),
  // Where scheduled test sends are delivered. Must itself be on the allow-list.
  OUTREACH_TEST_INBOX: z.string().default(''),
  // "capture": record the email exactly as it would be delivered, no network.
  // "smtp": deliver it to the test inbox through the SMTP settings below.
  OUTREACH_TEST_TRANSPORT: z.enum(['capture', 'smtp']).default('capture'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: bool.default('false'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  // The From address; defaults to the sender set in Settings → Outreach sender.
  SMTP_FROM: z.string().default(''),
  /** How often the test sender looks for due emails. */
  OUTREACH_TEST_DISPATCH_INTERVAL_MINUTES: z.coerce.number().int().min(1).max(60).default(5),


  // ── Task #983: engagement tracking ──────────────────────────────────────
  /**
   * Freshness thresholds, in hours.
   *
   * These produce a LABEL only. Nothing in Task #983 weights, ranks or scores
   * on freshness; the raw age is stored beside the label so a later stage can
   * apply its own thresholds without trusting these.
   */
  ENGAGEMENT_FRESH_HOURS: z.coerce.number().int().positive().max(8760).default(24),
  ENGAGEMENT_RECENT_HOURS: z.coerce.number().int().positive().max(8760).default(168),

  /**
   * How wide a window collapses repeats of a `repeatable` event.
   *
   * Deliberately short. It exists to absorb a double-submitted form or a
   * browser prefetch, not to merge two separate visits — two genuine clicks
   * minutes apart must remain two events.
   */
  ENGAGEMENT_DEDUPE_BUCKET_SECONDS: z.coerce.number().int().positive().max(3600).default(10),

  /** Forward tolerance for an untrusted clock before a timestamp is clamped. */
  ENGAGEMENT_MAX_CLOCK_SKEW_MINUTES: z.coerce.number().int().nonnegative().max(1440).default(5),
  /** How far back an untrusted source may claim an event happened. */
  ENGAGEMENT_MAX_BACKDATE_DAYS: z.coerce.number().int().positive().max(365).default(30),

  /** Ceiling on stored metadata keys, so a payload cannot arrive one key at a time. */
  ENGAGEMENT_MAX_METADATA_KEYS: z.coerce.number().int().positive().max(50).default(12),

  /** Per-IP ceiling on public engagement capture, per minute. */
  ENGAGEMENT_PUBLIC_RATE_LIMIT: z.coerce.number().int().positive().default(120),

  /**
   * Shared secret for provider webhook signature verification.
   *
   * Empty means no email provider webhook is trusted. An unverified webhook is
   * REJECTED rather than accepted-and-flagged: an unauthenticated caller must
   * not be able to write a delivery, an open or a bounce into an account's
   * history.
   */
  ENGAGEMENT_WEBHOOK_SECRET: z.string().default(''),
  /** Tolerated age of a signed webhook timestamp, to bound replay. */
  ENGAGEMENT_WEBHOOK_TOLERANCE_SECONDS: z.coerce.number().int().positive().max(3600).default(300),


  // ── Task #984: intent scoring ───────────────────────────────────────────
  /**
   * The scoring policy new calculations use by default.
   *
   * Named rather than implicit so that changing the active policy is a
   * deliberate configuration change, and so a score always records which
   * version produced it.
   */
  INTENT_SCORE_POLICY_VERSION: z.string().min(1).default('v1-provisional'),

  /**
   * Whether recording an engagement event schedules a rescore.
   *
   * The scoring job is a HANDOFF from event capture, never scoring inline.
   * Turning this off leaves the API and the batch recalculation working.
   */
  INTENT_SCORE_AUTO_RECALCULATE: bool.default('true'),

  /**
   * How long one company's rescore requests collapse into a single job.
   *
   * A Workbench visit emits ten events in seconds; without this the same
   * calculation would run ten times over an input that barely changed.
   */
  INTENT_SCORE_DEBOUNCE_SECONDS: z.coerce.number().int().positive().max(3600).default(60),

  /** Ceiling on one batch recalculation, so a sweep cannot run unbounded. */
  INTENT_SCORE_MAX_BATCH: z.coerce.number().int().positive().max(2000).default(200),


  // ── Task #985: sales qualification ──────────────────────────────────────
  /** The qualification policy new evaluations use by default. */
  SALES_QUALIFICATION_POLICY_VERSION: z.string().min(1).default('sq1-provisional'),

  /**
   * Whether a score change schedules a qualification evaluation.
   *
   * The evaluation is a HANDOFF from scoring, never qualification logic inside
   * the scoring code. Turning this off leaves the API and the batch path working.
   */
  SALES_QUALIFICATION_AUTO_EVALUATE: bool.default('true'),

  /** How long one company's evaluation requests collapse into a single job. */
  SALES_QUALIFICATION_DEBOUNCE_SECONDS: z.coerce.number().int().positive().max(3600).default(60),

  /** Ceiling on one batch evaluation, so a sweep cannot run unbounded. */
  SALES_QUALIFICATION_MAX_BATCH: z.coerce.number().int().positive().max(2000).default(200),

  /**
   * A verified NXT Sales user id to own leads whose company has no account owner.
   *
   * Empty by default, and DELIBERATELY so: a lead with no owner is reported as
   * unassigned rather than routed to somebody who is not responsible for it.
   * The id is checked against the real user list before it is used.
   */
  /**
   * REGION-WISE round-robin (confirmed rule).
   *
   * A qualified lead is assigned by finding the sales group for the company's
   * region, then rotating within that group. There is no global rotation: a
   * lead in a region with no configured group is left UNASSIGNED with the
   * reason stated, because assigning it to whoever was next would be inventing
   * a region-to-user mapping.
   *
   * Format — regions separated by `;`, ids within a region by `,`:
   *
   *   US:userIdA,userIdB;GB:userIdA;AE:userIdB
   *
   * Region keys are matched against the company's country after the same
   * normalisation the job-board registry uses, so "USA", "United States" and
   * "US" all resolve to the `US` group. A key that is not a recognised country
   * is matched literally, which allows a grouping like `EMEA` if the business
   * later defines one — but this platform never invents such a grouping.
   */
  SALES_REGION_ROUND_ROBIN: z.string().default(''),
  SALES_FALLBACK_OWNER_CRM_USER_ID: z.string().default(''),

  /** A named queue a team watches, used when no individual owner is found. */
  SALES_QUEUE_NAME: z.string().default(''),

  /** Incoming-webhook URL for Slack alerts. Empty means no Slack alerting. */
  SALES_ALERT_SLACK_WEBHOOK_URL: z.string().default(''),

  /** Base URL the internal deep link in an alert points at. */
  SALES_INTERNAL_BASE_URL: z.string().url().default('http://localhost:3000'),


  // ── Task #986: CRM sync ─────────────────────────────────────────────────
  /**
   * Which provider handles the CRM handoff.
   *
   * `nxt_sales` reports write_not_supported until an approved write adapter
   * exists; `outbox` holds the prepared package. Neither writes to a CRM.
   */
  /**
   * The master switch for writing anything to NXT Sales. OFF by default.
   *
   * Team Answer Section 30 approves a controlled write adapter scoped to
   * additive fields — Company intent score, Company qualification status, and
   * Notes/Activities. Approving the scope is not the same as opening the path,
   * so nothing writes until this is deliberately set to true.
   *
   * Turning it on is NOT sufficient. The destination fields below must also be
   * configured, and today they cannot be: NXT Sales holds two custom field
   * definitions and BOTH are on `Deal`. There are ZERO on `Company`, so the
   * intent score and qualification status have nowhere to go. Inventing a
   * field key would create a column nobody agreed to.
   */
  CRM_WRITE_ENABLED: bool.default('false'),
  /**
   * Whether a write may target a NON-LOCAL NXT Sales, i.e. the real CRM.
   *
   * Separate from CRM_WRITE_ENABLED on purpose. Enabling writes is a normal
   * thing to do against a local snapshot — it is how the write path is tested —
   * and the moment NXT_SALES_BASE_URL points at the live CRM, that same setting
   * would be aimed at records people depend on. Two independent switches mean
   * repointing the base URL cannot, on its own, make anything writable.
   *
   * Left off, this platform can read the live CRM and change nothing in it.
   */
  CRM_WRITE_ALLOW_LIVE: bool.default('false'),
  /**
   * The NXT Sales Company custom-field keys to write into.
   *
   * Empty because they do not exist yet. This is the exact configuration the
   * developer question in Team Answer M.4 has to settle: someone must create
   * the Company custom fields and name them here. Until then the write path
   * refuses with that reason rather than guessing a key.
   */
  CRM_WRITE_FIELD_INTENT_SCORE: z.string().default(''),
  CRM_WRITE_FIELD_QUALIFICATION_STATUS: z.string().default(''),
  /**
   * Maps this engine's qualification status onto the live dropdown's options.
   *
   * `qualificationStatus` is a DROPDOWN on the live Company record, and NXT
   * Sales rejects any value outside its configured option list with a 400
   * (see server/src/utils/customFieldValues.js). Our four internal statuses —
   * not_qualified, qualified, qualified_unassigned, de_qualified — are
   * therefore not writable unless each one is mapped to a real option.
   *
   * Format: `internal=Live Option;internal=Live Option`, for example
   *   qualified=Qualified;qualified_unassigned=Qualified (Unassigned)
   *
   * Empty by default and the write fails closed. Choosing the option labels
   * ourselves would either invent values the dropdown does not offer, or
   * quietly collapse two distinct states into one — and the distinction
   * between "qualified" and "qualified but nobody owns it" is the whole point
   * of keeping them apart.
   */
  CRM_WRITE_QUALIFICATION_VALUE_MAP: z.string().default(''),

  CRM_SYNC_PROVIDER: z.enum(['nxt_sales', 'outbox', 'none']).default('nxt_sales'),

  /** Whether a qualified lead with no sales owner may still be handed over. */
  CRM_SYNC_ALLOW_UNASSIGNED: bool.default('true'),

  /**
   * Whether the customer-facing Workbench link may be placed in the CRM.
   *
   * FALSE by default. The link is a bearer credential — anyone holding it can
   * open the demonstration — and a shared CRM field is a wide audience.
   */
  CRM_SYNC_INCLUDE_WORKBENCH_LINK: bool.default('false'),

  /** Whether a qualification schedules a CRM handoff automatically. */
  CRM_SYNC_AUTO: bool.default('true'),
  CRM_SYNC_DEBOUNCE_SECONDS: z.coerce.number().int().positive().max(3600).default(60),
  /** Bounded retries for transient provider failures only. */
  CRM_SYNC_MAX_ATTEMPTS: z.coerce.number().int().positive().max(20).default(5),

  DEFAULT_TENANT_SLUG: z.string().min(1).default('default'),
  DEFAULT_TENANT_NAME: z.string().min(1).default('Default Tenant'),

  CRM_DRIVER: z.enum(['real', 'fake']).default('real'),
  LLM_DRIVER: z.enum(['real', 'fake']).default('real'),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')
  // eslint-disable-next-line no-console
  console.error(`\nInvalid configuration — refusing to start:\n${issues}\n`)
  process.exit(1)
}

export const env = parsed.data

// The embedding dimension is baked into the vector column width, so a mismatch
// here would only surface as an opaque Postgres error on the first insert.
if (env.GEMINI_EMBEDDING_DIMENSIONS !== 768) {
  // eslint-disable-next-line no-console
  console.error(
    `\nGEMINI_EMBEDDING_DIMENSIONS is ${env.GEMINI_EMBEDDING_DIMENSIONS} but KnowledgeChunk.embedding ` +
      `is vector(768). Change the column and re-embed the corpus, or set it back to 768.\n`,
  )
  process.exit(1)
}

if (env.CRM_DRIVER === 'real' && !env.NXT_SALES_SERVICE_USER_ID) {
  // eslint-disable-next-line no-console
  console.error('\nCRM_DRIVER=real requires NXT_SALES_SERVICE_USER_ID. See README "Service account".\n')
  process.exit(1)
}

// The development-only bypass is refused in production rather than merely
// discouraged. A customer-facing Workbench built from an unreviewed report
// would defeat Task #980 entirely, so the process will not start with both set.
// Self-approval defeats the separation the whole human gate rests on: the
// person who asked for a run must not be the person who signs it off. The flag
// exists so a solo developer can exercise the flow locally, and it already
// defaults to false — but a default is not a guarantee, and the two flags below
// it were guarded here while this one was not.
if (env.NODE_ENV === 'production' && env.ALLOW_SELF_APPROVAL) {
  // eslint-disable-next-line no-console
  console.error(
    '\nALLOW_SELF_APPROVAL is a development-only flag and cannot be enabled in production.\n' +
      'An approval is a second person agreeing. With this on, a requester can approve their own\n' +
      'run, and the audit trail records a review that never happened.\n',
  )
  process.exit(1)
}

// The fake drivers return fabricated CRM records and fabricated model output.
// They exist so the test suite never touches a real CRM, which is exactly why
// they must not be reachable in production: the fixtures would flow through the
// normal UI, the normal reports and the normal CRM package with nothing marking
// them as invented.
if (env.NODE_ENV === 'production' && env.CRM_DRIVER === 'fake') {
  // eslint-disable-next-line no-console
  console.error(
    '\nCRM_DRIVER=fake cannot be used in production.\n' +
      'The fake adapter serves invented companies, deals and users. In production that is\n' +
      'fabricated business data presented as real.\n',
  )
  process.exit(1)
}

if (env.NODE_ENV === 'production' && env.LLM_DRIVER === 'fake') {
  // eslint-disable-next-line no-console
  console.error(
    '\nLLM_DRIVER=fake cannot be used in production.\n' +
      'The fake gateway replays canned fixtures. Any narrative built on it would be invented\n' +
      'text presented as analysis.\n',
  )
  process.exit(1)
}

if (env.NODE_ENV === 'production' && env.WORKBENCH_ALLOW_UNAPPROVED) {
  // eslint-disable-next-line no-console
  console.error(
    '\nWORKBENCH_ALLOW_UNAPPROVED is a development-only flag and cannot be enabled in production.\n' +
      'A customer-facing Workbench must be built from a report approved in Task #980.\n',
  )
  process.exit(1)
}

// The same rule for the courier report, and for the same reason: a customer
// PDF built from an unreviewed report, or carrying placeholder legal wording,
// is a document that leaves the building without anyone having signed it off.
if (env.NODE_ENV === 'production' && env.REPORT_ALLOW_UNAPPROVED) {
  // eslint-disable-next-line no-console
  console.error(
    '\nREPORT_ALLOW_UNAPPROVED is a development-only flag and cannot be enabled in production.\n' +
      'A customer report must be generated from a report approved in Task #980.\n',
  )
  process.exit(1)
}

// Auto-send with no configured provider is a contradiction that should fail
// loudly rather than produce a campaign that silently blocks every action.
if (env.OUTREACH_AUTO_SEND && env.EMAIL_PROVIDER === 'none' && env.WHATSAPP_PROVIDER === 'none') {
  // eslint-disable-next-line no-console
  console.error(
    '\nOUTREACH_AUTO_SEND is enabled but no sending provider is configured.\n' +
      'Configure EMAIL_PROVIDER or WHATSAPP_PROVIDER, or leave auto-send off.\n',
  )
  process.exit(1)
}

if (env.LLM_DRIVER === 'real' && !env.GEMINI_API_KEY) {
  // eslint-disable-next-line no-console
  console.error('\nLLM_DRIVER=real requires GEMINI_API_KEY.\n')
  process.exit(1)
}

// An inverted pair would silently make "recent" unreachable, so the labels stop
// meaning what the report says they mean.
if (env.ENGAGEMENT_FRESH_HOURS >= env.ENGAGEMENT_RECENT_HOURS) {
  // eslint-disable-next-line no-console
  console.error(
    `\nENGAGEMENT_FRESH_HOURS (${env.ENGAGEMENT_FRESH_HOURS}) must be less than ` +
      `ENGAGEMENT_RECENT_HOURS (${env.ENGAGEMENT_RECENT_HOURS}).\n`,
  )
  process.exit(1)
}

export type Env = typeof env
