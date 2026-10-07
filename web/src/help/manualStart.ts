import type { ManualSection } from './manualTypes'

// GETTING STARTED, PROSPECTS, ENRICHMENT AND INTENT SIGNALS.
//
// Every label in quotes below is the exact text on screen. If a screen
// changes, change the matching sentence here too — a manual that names a
// button that is not there is worse than no manual.

export const GETTING_STARTED: ManualSection = {
  id: 'getting-started',
  title: 'Getting Started',
  summary: 'What the Marketing AI Agent does, how to sign in, and how the screen is laid out.',
  blocks: [
    { kind: 'heading', text: 'What this application does' },
    {
      kind: 'text',
      text: 'The Marketing AI Agent helps you find companies that could use our service, learn about them, find the right person to contact, and prepare the emails to send them. You stay in control the whole way: nothing is emailed to a customer unless a person has read it, approved it and sent it.',
    },
    { kind: 'text', text: 'You always work in this order:' },
    {
      kind: 'steps',
      items: [
        'Prospects — find companies.',
        'Select a company — choose the one you want to work on.',
        'Enrichment — read that company’s website.',
        'Intent Signals — look for signs the company may need us.',
        'Decision Makers — find the right person to contact.',
        'Outreach — prepare, check, approve and send the emails.',
        'Several Companies — do the first email for up to 10 companies at once (a test run).',
      ],
    },
    {
      kind: 'example',
      text: 'You search for "Safety and Health companies in the USA". You pick "Acme Safety" from the results. Enrichment reads acmesafety.com, Intent Signals finds a recent news story about them, Decision Makers finds their Head of eCommerce, and Outreach prepares the first email to that person for you to check and send.',
    },

    { kind: 'heading', text: 'Signing in' },
    {
      kind: 'steps',
      items: [
        'Open the application in your browser.',
        'If you already have an account, type your email and password and click "Sign in".',
        'If this is your first time, click "Create account". Type your work email address and click "Send me a code".',
        'Open your email. You will receive a 6-digit code. Type it into the "Verification code" box.',
        'Type your name (optional), then choose a password and type it twice. It must be at least 10 characters and include a letter and a number.',
        'Click "Create account". You are signed in.',
      ],
    },
    {
      kind: 'tip',
      text: 'Forgot your password? Click "Forgot password?" on the sign-in page, type your email, and you will get a code to set a new password. Each code works once and stops working after 10 minutes — if it has expired, click "Send another code".',
    },
    {
      kind: 'text',
      text: 'Only work email addresses from our company can create an account. The sign-in page says which addresses are accepted.',
    },

    { kind: 'heading', text: 'How the screen is laid out' },
    {
      kind: 'terms',
      items: [
        { term: 'Left menu', meaning: 'The steps of the workflow: Command Centre (home), then Prospect, Enrichment, Intent, Decision Makers, Outreach and Engagement, and Settings at the bottom. Click one to open it. "Collapse" at the bottom makes the menu narrower.' },
        { term: 'Top bar', meaning: 'Shows which screen you are on, the company you are working on, your name and your role. On the right: the panel button, Help (the question mark — this manual), Settings, the light/dark switch, and Sign out.' },
        { term: 'Shared context (right panel)', meaning: 'Shows the company you are working on, and lets you choose a different one. Every step works on the company shown here.' },
        { term: 'Command Centre', meaning: 'The home screen — an overview of the whole workflow.' },
      ],
    },
    {
      kind: 'tip',
      text: 'Can’t see the right panel? On a smaller window it hides itself. Click the panel button in the top bar ("Show company context") to bring it back.',
    },

    { kind: 'heading', text: 'Your role — what you are allowed to do' },
    {
      kind: 'text',
      text: 'Your role is shown next to your name in the top bar. It decides which buttons you see.',
    },
    {
      kind: 'terms',
      items: [
        { term: 'operator', meaning: 'The usual role. You can search, run every step and prepare emails. You cannot approve an email — someone with approval rights does that.' },
        { term: 'approver', meaning: 'Can approve emails and add companies to NXT Sales.' },
        { term: 'admin', meaning: 'Can do everything, including the team list and usage costs in Settings. Administrators are set by the people who run the server.' },
        { term: 'viewer', meaning: 'Can look at everything but cannot run anything.' },
      ],
    },
    {
      kind: 'tip',
      text: 'If this manual mentions a button you cannot see, your role probably does not include it. Ask an administrator.',
    },

    { kind: 'heading', text: 'Info buttons (i)' },
    {
      kind: 'text',
      text: 'Many titles have a small (i) button next to them. Click it to see a short explanation of that item and what to do next. Press Escape, or click anywhere else, to close it.',
    },

    { kind: 'heading', text: 'Things that take a little time' },
    {
      kind: 'text',
      text: 'Searches and runs happen in the background. While they work you will see "Queued" (waiting to start) and then "Running". You do not need to refresh — the screen checks again every few seconds and updates by itself. You can move to another screen and come back.',
    },
    {
      kind: 'warning',
      text: 'If something stays "Queued" for more than a minute, the background service is probably not running. This is not something you can fix from the screen — tell your administrator. See Troubleshooting.',
    },
  ],
}

export const PROSPECTS: ManualSection = {
  id: 'prospects',
  title: 'Prospects',
  summary: 'Find new companies on the public web, see one of their product pages, and choose a company to work on.',
  blocks: [
    { kind: 'heading', text: 'What it is' },
    {
      kind: 'text',
      text: 'Prospects — "Prospect" in the left menu, and "Prospect Discovery" at the top of its screen — searches the public web for companies that match what you describe. For each company it finds, it opens the company’s own website, picks one real product, and checks whether that product’s information has gaps our service could fill.',
    },

    { kind: 'heading', text: 'Why we use it' },
    {
      kind: 'text',
      text: 'To find companies that genuinely need our service — and to have a real example from their own website to talk to them about.',
    },

    { kind: 'heading', text: 'The two tabs at the top' },
    {
      kind: 'terms',
      items: [
        { term: 'Find new companies', meaning: 'Search the public web for companies. Use this to find new prospects.' },
        { term: 'Selected company', meaning: 'Shows the company you have already chosen. It is greyed out until you choose one.' },
      ],
    },

    { kind: 'heading', text: 'What you enter — the search' },
    {
      kind: 'steps',
      items: [
        'Open the "Find new companies" tab.',
        'In the box "Describe the companies you\'re looking for", type what you want in plain words: the kind of company, what they sell, and where.',
        'Click "Search the public web". The button works once you have typed at least two letters.',
      ],
    },
    {
      kind: 'example',
      text: '"Safety and Health companies in the USA", "Industrial tool distributors in Texas", "Medical equipment suppliers in Malta".',
    },
    {
      kind: 'text',
      text: 'Search filters: there are no separate drop-down filters for industry, country or size. Your description is the filter — the more precisely you describe the companies, the better the results. If you name a place, companies outside it are left out.',
    },
    {
      kind: 'tip',
      text: 'Your earlier searches are listed under "Recent searches". Choose one to see its results again. The bin icon removes a search from your list — the companies it found are kept.',
    },

    { kind: 'heading', text: 'What the system does' },
    {
      kind: 'list',
      items: [
        'Searches the public web for companies that match your description.',
        'Opens each company’s own website and finds one genuine individual product (never a category page or an article).',
        'Reads that product’s description, details and specifications, and checks what is missing.',
        'Checks each company against NXT Sales, so you know whether we already have it.',
      ],
    },
    {
      kind: 'text',
      text: 'A search can take several minutes because it opens many websites. While it works you will see "Searching the public web and checking one product on each company’s website", with a count of websites checked so far.',
    },

    { kind: 'heading', text: 'What you get — the company results' },
    {
      kind: 'text',
      text: 'When the search finishes you see a summary line such as "24 companies found · 18 products analysed, one per company · 6 opportunities". The companies are then sorted into groups:',
    },
    {
      kind: 'terms',
      items: [
        { term: 'Our service is needed', meaning: 'The product checked is missing core information. These are your best prospects.' },
        { term: 'Possible opportunity', meaning: 'The product checked has one clear gap in its information.' },
        { term: 'Review manually', meaning: 'A product page was found, but the website blocks automatic reading. Open the product link and judge it yourself.' },
        { term: 'No clear need', meaning: 'The product checked already has complete information.' },
        { term: 'No genuine product page', meaning: 'The website was opened but no single product could be found.' },
        { term: 'Could not be checked', meaning: 'The company was found, but its website could not be checked. The reason is shown for each one.' },
      ],
    },
    {
      kind: 'text',
      text: 'Each group shows 10 companies at a time — use "Previous" and "Next" or the page numbers to see more.',
    },

    { kind: 'heading', text: 'Product page details' },
    {
      kind: 'text',
      text: 'Each opportunity card shows the company’s name, website and location, then a "Product page" box with the product that was checked:',
    },
    {
      kind: 'list',
      items: [
        'The product name (click it to open the real page), its address and category.',
        'Product pictures, identifiers such as SKU or brand, the description and feature points.',
        'Price, buying options (like add to cart or request a quote) and downloads such as datasheets.',
        'The specifications table.',
      ],
    },
    { kind: 'text', text: 'Below that, the card explains its verdict:' },
    {
      kind: 'terms',
      items: [
        { term: 'Why our service is relevant', meaning: 'One sentence saying why this company could use us.' },
        { term: 'Issues identified', meaning: 'What is wrong or missing — for example "No product description" or "Few attributes".' },
        { term: 'Missing information', meaning: 'Small labels for each missing item. Hover over one for a suggestion.' },
        { term: 'What our service would do', meaning: 'Up to three things we would improve, such as "Write a complete product description".' },
        { term: 'What the Marketing Agent should do next', meaning: 'A suggestion for how to approach the company, using this product as the example.' },
        { term: 'How the product was read', meaning: 'Click to open. Shows exactly where each detail was read on the page.' },
      ],
    },

    { kind: 'heading', text: 'NXT Sales check' },
    {
      kind: 'terms',
      items: [
        { term: 'New — not in NXT Sales', meaning: 'We do not have this company yet.' },
        { term: 'In NXT Sales', meaning: 'We already have this company. It is never created twice.' },
        { term: 'Same name in NXT Sales — different website', meaning: 'A company with the same name exists with another website. Check whether it is the same company.' },
        { term: 'Check again', meaning: 'Checks NXT Sales again — useful if someone has just added the company.' },
        { term: 'Add to NXT Sales', meaning: 'Creates the company in NXT Sales, owned by you, with Lead Source "Marketing AI Agent". You are asked to confirm first. Only people with approval rights see this button.' },
      ],
    },

    { kind: 'heading', text: 'Select a company' },
    {
      kind: 'steps',
      items: [
        'Find the company you want in the results.',
        'Click "Select" on its card. It becomes your selected company and the screen switches to the "Selected company" tab.',
        'Click "Start pipeline for this company". This opens Enrichment with that company already chosen.',
      ],
    },
    {
      kind: 'text',
      text: 'You can also choose a company in the right-hand "Shared context" panel: click "Select a company", type part of a name in the search box ("Company or industry…"), and click the company. Companies already in NXT Sales appear under "In NXT Sales" once you type two letters.',
    },
    {
      kind: 'warning',
      text: 'Clicking "Select" does not start anything and does not change NXT Sales. It only chooses the company you will work on.',
    },

    { kind: 'heading', text: 'What to do next' },
    {
      kind: 'text',
      text: 'Once a company is selected, click "Start pipeline for this company" to go to Enrichment.',
    },
  ],
}

export const ENRICHMENT: ManualSection = {
  id: 'enrichment',
  title: 'Enrichment',
  summary: 'Read the selected company’s website and record the technology it uses.',
  blocks: [
    { kind: 'heading', text: 'What it is' },
    {
      kind: 'text',
      text: 'Enrichment ("Company Enrichment") reads the selected company’s own website and records what technology it uses — for example its online shop platform, website system and analytics tools — with the proof for each one.',
    },

    { kind: 'heading', text: 'Why we use it' },
    {
      kind: 'text',
      text: 'It tells you how the company runs its website, which is useful when you talk to them. The next step, Intent Signals, also uses this information — so run Enrichment first.',
    },

    { kind: 'heading', text: 'What you enter or select' },
    {
      kind: 'text',
      text: 'Nothing to type. Enrichment always works on the company shown in the Shared context panel. Make sure the right company is selected.',
    },
    {
      kind: 'steps',
      items: [
        'Check the company name in the top bar or the right panel.',
        'Click "Run enrichment" at the top right.',
        'Wait — it usually takes a few seconds. The screen updates by itself.',
      ],
    },

    { kind: 'heading', text: 'What the system does' },
    {
      kind: 'list',
      items: [
        'Takes the company’s website from NXT Sales (or from the Prospects search, for a newly found company).',
        'Opens one page of the website, usually the home page.',
        'Looks for the tell-tale signs that show which technology the site uses.',
        'Records only what it can prove. It does not guess, and it does not change NXT Sales.',
      ],
    },

    { kind: 'heading', text: 'What you get' },
    {
      kind: 'terms',
      items: [
        { term: 'What we know about …', meaning: 'A summary: how many technology signals and facts were found, and whether the website could be read.' },
        { term: 'Company and website', meaning: 'Details from NXT Sales (industry, country, website) — or, for a company found by the web search and not in NXT Sales yet, from its own website — and details read from the website (page title, description). The country is shown only when a source states it.' },
        { term: 'Technology detected on the site', meaning: 'Each technology found, how sure we are (high, medium or low), and the proof. Click "Why we say this" to see the proof.' },
        { term: 'Reference', meaning: 'Opens the exact piece of the website a detail was read from.' },
      ],
    },
    {
      kind: 'tip',
      text: '"Nothing detected" is a real answer, not an error. Many websites do not show which technology they use.',
    },

    { kind: 'heading', text: 'Statuses' },
    {
      kind: 'terms',
      items: [
        { term: 'Not run', meaning: 'Enrichment has never been run for this company.' },
        { term: 'Queued', meaning: 'Waiting to start.' },
        { term: 'Running', meaning: 'Reading the website now.' },
        { term: 'Enriched', meaning: 'Finished successfully.' },
        { term: 'Partial', meaning: 'The website could not be read, or it sent us to a different website. Only the NXT Sales details were recorded.' },
        { term: 'Blocked', meaning: 'There is no website to read. Add the website to the company in NXT Sales, then run again.' },
        { term: 'Failed', meaning: 'The run did not finish. The reason is shown — try "Run enrichment" again.' },
      ],
    },

    { kind: 'heading', text: 'What to do next' },
    {
      kind: 'text',
      text: 'When it says "Enrichment complete", click "Next Intent Signals" (or Intent in the left menu).',
    },
  ],
}

export const INTENT_SIGNALS: ManualSection = {
  id: 'intent-signals',
  title: 'Intent Signals',
  summary: 'Find public signs that the selected company may need our service.',
  blocks: [
    { kind: 'heading', text: 'What it is' },
    {
      kind: 'text',
      text: 'Intent Signals looks for public signs that something is happening at the company — news stories, forum and Reddit discussions, reviews, community questions and technology changes. Each sign comes with its source link and date.',
    },

    { kind: 'heading', text: 'Why we use it' },
    {
      kind: 'text',
      text: 'A recent, real event gives you a reason to contact the company now, and something relevant to say. Job adverts are not used.',
    },

    { kind: 'heading', text: 'What you enter or select' },
    {
      kind: 'steps',
      items: [
        'Make sure the right company is selected (top bar or right panel).',
        'Click "Detect signals" at the top right. If it has run before, the button says "Detect again".',
        'Wait. The screen updates by itself every few seconds.',
      ],
    },
    {
      kind: 'tip',
      text: 'Run Enrichment first. Intent Signals uses what Enrichment found about the website.',
    },

    { kind: 'heading', text: 'What the system does' },
    {
      kind: 'text',
      text: 'It checks six places in turn: the company’s NXT Sales record, the technology Enrichment found, the public profiles the company links to (such as LinkedIn), a search of the open web, outside sources (forums, Reddit, reviews, news and blogs), and community questions. It keeps only what those sources actually said.',
    },

    { kind: 'heading', text: 'What you get — the signal cards' },
    {
      kind: 'text',
      text: '"Detected signals" lists each sign, newest first. Each card shows:',
    },
    {
      kind: 'list',
      items: [
        'What happened, and a category label such as news, technology or business.',
        'How reliable the source is: high, medium or low confidence. (This is about the source, not how likely a sale is.)',
        '"Why it matters" — what the sign may mean for us.',
        'The source link and the date it happened.',
        '"View Reference" — opens the full detail, including a suggested "Outreach angle" you can use in your email.',
      ],
    },
    {
      kind: 'terms',
      items: [
        { term: 'weak', meaning: 'Low confidence, or the source gave no date.' },
        { term: 'expired', meaning: 'More than 90 days old, or no longer true.' },
        { term: 'counts against outreach', meaning: 'A sign that suggests this is not a good time to contact them.' },
        { term: 'earlier run', meaning: 'Found by a previous run, still shown.' },
      ],
    },
    {
      kind: 'example',
      text: 'A card says a public post mentions that the company is launching a new online shop. That is a good reason to get in touch now about their product information.',
    },

    { kind: 'heading', text: 'Statuses' },
    {
      kind: 'terms',
      items: [
        { term: 'NOT RUN', meaning: 'Nothing has been looked for yet.' },
        { term: 'QUEUED', meaning: 'Waiting to start.' },
        { term: 'RUNNING', meaning: 'Looking now. Signals appear as each source finishes.' },
        { term: 'COMPLETED', meaning: 'Finished. "No qualifying signals observed" is a real answer — nothing relevant was found.' },
        { term: 'PARTIAL', meaning: 'Finished, but some sources could not be checked. The rest are shown.' },
        { term: 'BLOCKED', meaning: 'None of the sources could be checked. Nothing shown is about the company.' },
        { term: 'FAILED', meaning: 'The run stopped. The reason is shown — try "Detect again".' },
      ],
    },

    { kind: 'heading', text: 'What to do next' },
    {
      kind: 'text',
      text: 'Note the strongest signal and its outreach angle, then click "Next Decision Maker Discovery" (or Decision Makers in the left menu).',
    },
  ],
}
