import type { ManualSection } from './manualTypes'

// DECISION MAKERS, OUTREACH, SEVERAL COMPANIES AND TROUBLESHOOTING.
//
// Every label in quotes is the exact text on screen. Where something does not
// exist (a Name field, Resume after Stop, a live-send button) the manual says
// so plainly, because a beginner will look for it.

export const DECISION_MAKERS: ManualSection = {
  id: 'decision-makers',
  title: 'Decision Makers',
  summary: 'Find the right person to contact at the selected company, and their email address.',
  blocks: [
    { kind: 'heading', text: 'What it is' },
    {
      kind: 'text',
      text: 'Decision Makers ("Decision Maker Discovery") finds the person at the company who is responsible for product information — the person your emails should go to — and their email address if one can be found.',
    },

    { kind: 'heading', text: 'Why we use it' },
    {
      kind: 'text',
      text: 'Every email is written to a named person. Outreach uses the person this step finds.',
    },

    { kind: 'heading', text: 'What you enter or select' },
    {
      kind: 'steps',
      items: [
        'Make sure the right company is selected.',
        'Click "Find decision makers" at the top right. While it works the button says "Search in progress".',
        'Wait. The screen updates by itself every few seconds.',
      ],
    },

    { kind: 'heading', text: 'What the system does' },
    {
      kind: 'text',
      text: 'It looks at the company’s own website, public pages (news, directories, organisation charts) and contact databases. Every person it finds is checked: they must be named on a real page and clearly work at this company in a relevant role. Nothing is guessed — not a name, not an email address.',
    },

    { kind: 'heading', text: 'What you get' },
    {
      kind: 'terms',
      items: [
        { term: 'People seen / Shortlisted / Set aside', meaning: 'How many people were found, how many passed the checks, and how many were left out.' },
        { term: 'Primary contact', meaning: 'The best person. Outreach writes to this person.' },
        { term: 'Alternative contact', meaning: 'Another good person, shown for your information. Outreach does not use them automatically.' },
        { term: 'Confidence', meaning: 'High, medium or low — how strong the proof is that this is the right person.' },
        { term: 'Found but set aside', meaning: 'People who were named somewhere but left out, grouped by reason — for example "Works somewhere else" or "Role does not own product data". Outreach never uses them.' },
      ],
    },

    { kind: 'heading', text: 'The email address' },
    {
      kind: 'text',
      text: 'Each shortlisted person shows their email if one was found, with where it came from. If no personal email was found, you see a note such as "No verified person email found. Nothing was guessed from the name or the domain."',
    },
    {
      kind: 'text',
      text: 'When the main contact has no email, the system looks for the company’s shared mailbox (such as sales@ or info@) written on its own website or in NXT Sales. If found, it shows "Company mailbox for outreach: …" — emails then go there.',
    },
    {
      kind: 'tip',
      text: 'No address at all? You can still continue: in Outreach you can type the address yourself in the "Goes to" box. If you found the contact yourself — for example on LinkedIn or the company’s website — paste it there.',
    },
    {
      kind: 'text',
      text: '"Add to NXT Sales" next to a person adds them to NXT Sales. Only people with approval rights see this button.',
    },

    { kind: 'heading', text: 'If nobody is found' },
    {
      kind: 'text',
      text: 'You may see "Nobody verified yet". This is a real answer: the system will not invent a person it cannot prove. You can run it again later, or use Several Companies, where you can type an email address for a company even with no decision maker.',
    },

    { kind: 'heading', text: 'What to do next' },
    {
      kind: 'text',
      text: 'Check the Primary contact and their email look right, then go to Outreach (click "Next in the pipeline", or Outreach in the left menu).',
    },
  ],
}

export const OUTREACH: ManualSection = {
  id: 'outreach',
  title: 'Outreach',
  summary: 'Prepare the emails, check and edit them, approve them, send them from Gmail, and handle follow-ups and replies.',
  blocks: [
    { kind: 'heading', text: 'What it is' },
    {
      kind: 'text',
      text: 'Outreach ("Multichannel Outreach") prepares the emails for one company, using our approved Sales templates filled in with that company’s details. It then guides you through checking, approving, sending and following up.',
    },
    {
      kind: 'warning',
      text: 'The application never emails a customer by itself. You send every email from your own Gmail. Every sentence is our approved wording — only the company name, product and the values you enter are filled in. No AI-written sentence and no website link is added.',
    },

    { kind: 'heading', text: 'Why we use it' },
    {
      kind: 'text',
      text: 'It saves you writing each email by hand, keeps every email to the approved wording, and reminds you when each follow-up is due.',
    },

    { kind: 'heading', text: 'The screen' },
    {
      kind: 'terms',
      items: [
        { term: 'One company / Several companies', meaning: 'Two tabs at the top. "One company" works on one company at a time. "Several companies" sends the first email to up to 10 companies in one go (see the next part of this manual).' },
        { term: 'Step guide', meaning: 'Company → Decision maker → Email draft → Review & edit → Approve → Send → Follow-ups. The highlighted step is where this company is now.' },
        { term: 'Who we are emailing', meaning: 'The company, the decision maker, the address the email goes to ("Email goes to") and the email version.' },
        { term: 'Next step', meaning: 'Tells you exactly what to do now, with the button for it.' },
        { term: 'Companies in outreach (right side)', meaning: 'Every company you are working on, with the most urgent first. "Overdue" means a follow-up date has passed.' },
      ],
    },

    { kind: 'heading', text: 'Step 1 — Start outreach' },
    {
      kind: 'steps',
      items: [
        'Make sure the right company is selected and it has a decision maker.',
        'Click "Start outreach" at the top right.',
        'The first email is written straight away as a draft. Nothing is sent.',
      ],
    },

    { kind: 'heading', text: 'V1 / V2 / V3 — the three versions' },
    {
      kind: 'text',
      text: 'There are three approved wordings of the first email: Version 1, Version 2 and Version 3. Each company is given one automatically, taking turns, so we can learn which works best.',
    },
    {
      kind: 'example',
      text: 'V1 subject: "Who AI recommends instead of [Company] for [Product]?"  ·  V2: "Ran a test on [Product] across the AI LLMs — thought you did want to see it"  ·  V3: "[Company] vs. the AI LLMs — a quick comparison".',
    },
    {
      kind: 'text',
      text: 'To use a different version, open the draft and click "V1", "V2" or "V3" before you approve.',
    },
    {
      kind: 'warning',
      text: 'Switching version rewrites the draft from the template. Any changes you typed into the text are lost (values you entered are kept), and the Sales confirmation must be ticked again.',
    },

    { kind: 'heading', text: 'Step 2 — Review and edit the draft' },
    {
      kind: 'text',
      text: 'Click "Review draft" (or "Review & approve") to open the email. You can change the subject and body directly.',
    },
    {
      kind: 'terms',
      items: [
        { term: 'Goes to', meaning: 'The address the email will go to. You can change it at any time: type or paste a new address and click "Save". Underneath it says where the address came from — "from Decision Makers", "company mailbox" or "entered by Sales".' },
        { term: 'Subject and Body', meaning: 'Edit the text, then click "Save changes". "Discard changes" undoes your edits.' },
        { term: 'Not filled yet', meaning: 'A gap in the text such as [Product] or [Name] still needs a value. The email cannot be approved until every gap is filled.' },
        { term: 'What was filled in', meaning: 'A table of every value placed into the template and where it came from.' },
        { term: 'Values from Sales', meaning: 'Boxes for things only you know — such as "Product", "Client Company Name", "SKU 1" to "SKU 5", or "X of 5 (from your report)". Fill them in and click "Save values".' },
        { term: 'Sales confirmation', meaning: 'A tick box where you confirm the test result the email talks about (for example, that you ran the product through ChatGPT, Claude, Perplexity and Gemini). The application does not run this test — you do, and you confirm it here. For "this week" emails it is valid for 7 days.' },
      ],
    },
    {
      kind: 'tip',
      text: 'To fill [Name] when there is no decision maker, type the person’s name over "[Name]" in the Body and click "Save changes". There is no separate Name box.',
    },
    {
      kind: 'example',
      text: 'The draft says "Not filled yet: [product]". Under "Values from Sales", type "safety helmets" in the "Product" box and click "Save values". The gap in the email is filled and the warning goes away.',
    },

    { kind: 'heading', text: 'Step 3 — The "Before approval" checklist' },
    {
      kind: 'text',
      text: 'Each item shows a tick or a cross. A cross tells you what is missing. Common items:',
    },
    {
      kind: 'list',
      items: [
        '"Every placeholder is filled" — no [Product], [Name] or other gaps left.',
        '"Sales confirmed the AI-engine test result stated in this email" — tick the Sales confirmation box.',
        '"A recipient email address is set" — fill the "Goes to" box.',
        '"The sender\'s name and company are known" — ask an administrator to set this up.',
        '"The company is not suppressed" — the company must not be blocked (see Troubleshooting).',
      ],
    },

    { kind: 'heading', text: 'Step 4 — Approve' },
    {
      kind: 'text',
      text: 'When every checklist item is ticked, someone with approval rights clicks "Approve" under "Your decision". Approve stays greyed out until the checklist passes and any changes are saved.',
    },
    {
      kind: 'terms',
      items: [
        { term: 'Approve', meaning: 'Confirms this exact email may be sent.' },
        { term: 'Reject & regenerate', meaning: 'Throws the draft away and writes a fresh one from the template. Your typed changes are lost.' },
        { term: 'Reject', meaning: 'Throws the draft away without making a new one.' },
      ],
    },
    {
      kind: 'warning',
      text: 'If you change an approved email (its text, its values or its "Goes to" address), it goes back to "Waiting for approval" and must be approved again.',
    },

    { kind: 'heading', text: 'Step 5 — Send it' },
    {
      kind: 'text',
      text: 'After approval, a "Send it" box appears with three options:',
    },
    {
      kind: 'terms',
      items: [
        { term: 'Open in Gmail', meaning: 'The easiest way. Opens a new Gmail message in a new tab with the To address, subject and text already filled in. Read it once more and click Send in Gmail.' },
        { term: 'Copy email', meaning: 'Copies the address, subject and text so you can paste them into any email program.' },
        { term: 'Other mail app', meaning: 'Opens your computer’s own email program, such as Outlook. Does nothing if your computer has no email program set up — use Open in Gmail instead.' },
      ],
    },
    {
      kind: 'tip',
      text: 'Make sure you are signed in to the right Gmail account before clicking "Open in Gmail".',
    },

    { kind: 'heading', text: 'Step 6 — Mark as sent' },
    {
      kind: 'steps',
      items: [
        'After you have sent the email from Gmail, come back to the application.',
        'Leave "Sent on" empty to use the current time, or enter when you sent it.',
        'Click "Mark as sent".',
      ],
    },
    {
      kind: 'warning',
      text: 'Always click "Mark as sent". This is how the application knows the email went — the follow-up dates are counted from this moment. If you forget, no follow-ups will come due.',
    },

    { kind: 'heading', text: 'The sequence and follow-ups' },
    {
      kind: 'text',
      text: 'The sequence is the planned set of emails for one company. "Day 0" is the day you marked the first email as sent. If the company does not reply, follow-ups come due on these days:',
    },
    {
      kind: 'terms',
      items: [
        { term: '1 · First email (V1, V2 or V3)', meaning: 'Sent when you start.' },
        { term: 'Check for a reply (Day 4–5)', meaning: 'A reminder to look for a reply. Not an email.' },
        { term: '2.3 · Follow up email for No Reply Prospects', meaning: 'Day 9–10. Needs the "Client Company Name" and the Sales confirmation.' },
        { term: '2.4 · Delivery of AI Report for No Reply Prospects', meaning: 'Day 12–14. Needs 5 SKU names, the report result (X of 5) and the report confirmation.' },
        { term: '3 · Expo Invite - Prospect never responded', meaning: 'Day 16–18. Shows "Not needed" if that date would be on or after the expo (2 November 2026).' },
        { term: '4 · Break up email', meaning: 'Day 18–20. Sending it ends the sequence.' },
      ],
    },
    {
      kind: 'text',
      text: 'If the company replies, the no-reply follow-ups stop and these may be used instead:',
    },
    {
      kind: 'terms',
      items: [
        { term: '2.1 · Follow up for Email-Reply Prospects', meaning: 'When they reply and send their SKUs. Due by the end of the next working day.' },
        { term: '2.2 · Delivery of SKUs with Enriched AI Readiness Report', meaning: 'Sends their report. Sending it ends the sequence.' },
        { term: '3.1 · Prospect replies as interested, but cant attend the expo', meaning: 'When they say they are interested but cannot come to the expo.' },
      ],
    },
    {
      kind: 'steps',
      items: [
        'When a follow-up is due, it shows "Follow-up due — prepare it". Click "Prepare draft".',
        'Review, fill any gaps, approve, send from Gmail and mark as sent — exactly like the first email.',
        'To leave a follow-up out, click "Skip", give a reason, and click "Confirm skip".',
      ],
    },
    {
      kind: 'tip',
      text: 'Nothing is prepared or sent automatically. You only need to act when a step says "Prepare", "Review" or "Send".',
    },

    { kind: 'heading', text: 'When the customer replies' },
    {
      kind: 'steps',
      items: [
        'In the "Replies" box, paste the customer’s reply into "Paste the prospect\'s reply", and set "Received" to when it arrived.',
        'Click "Read reply". The application suggests what kind of reply it is, quoting the words it relied on.',
        'Check the suggestion. If it is wrong, choose the right type under "What kind of reply is it?".',
        'Click "Confirm reading". Nothing changes until you confirm.',
      ],
    },
    {
      kind: 'terms',
      items: [
        { term: 'Sent SKUs', meaning: 'They sent their product codes. Follow-ups 2.1 and 2.2 are prepared.' },
        { term: 'Interested, cannot attend the expo', meaning: 'Follow-up 3.1 is prepared.' },
        { term: 'Interested, no SKUs yet / Wants more information', meaning: 'No template fits. The sequence says "Sales to reply personally" — write to them yourself.' },
        { term: 'Not interested', meaning: 'The sequence is stopped.' },
        { term: 'Follow up later', meaning: 'The sequence is paused until you click "Resume".' },
        { term: 'Unclear', meaning: 'Cannot be confirmed — choose the type yourself.' },
      ],
    },

    { kind: 'heading', text: 'Pause, Resume and Stop' },
    {
      kind: 'terms',
      items: [
        { term: 'Pause', meaning: 'Puts the company on hold. Nothing new can be prepared until you click "Resume".' },
        { term: 'Resume', meaning: 'Continues a paused sequence.' },
        { term: 'Stop sequence', meaning: 'Ends outreach to this company for good. There is no Resume after Stop, and no "are you sure?" question — use Pause if you might continue later.' },
      ],
    },

    { kind: 'heading', text: 'Statuses — what each word means' },
    {
      kind: 'terms',
      items: [
        { term: 'Waiting for approval', meaning: 'A draft is ready for checking and approval.' },
        { term: 'Ready to send', meaning: 'Approved. Send it from Gmail, then click "Mark as sent".' },
        { term: 'Sent', meaning: 'You marked it as sent.' },
        { term: 'Follow-up pending', meaning: 'A follow-up that is not due yet.' },
        { term: 'Follow-up due — prepare it', meaning: 'Prepare this follow-up now.' },
        { term: 'Overdue', meaning: 'The follow-up date has passed. You can still prepare it.' },
        { term: 'Not needed', meaning: 'This step does not apply to this company.' },
        { term: 'Skipped', meaning: 'You chose to leave this step out.' },
        { term: 'Stopped — they replied', meaning: 'Cancelled because the customer replied.' },
        { term: 'Cancelled', meaning: 'Rejected, or the sequence was stopped.' },
        { term: 'Scheduled / Due now', meaning: 'In Several companies: the email has its time and is waiting for it, or its time has come and you can send it.' },
      ],
    },
    {
      kind: 'text',
      text: 'Each company also has an overall phase: "Initial email", "No reply yet", "Replied", "Sales to reply personally", "Paused", "Stopped" or "Completed".',
    },

    { kind: 'heading', text: 'What to do next' },
    {
      kind: 'text',
      text: 'Check "Companies in outreach" each day — the most urgent company is at the top. To send first emails to several companies at once, use "Several companies".',
    },
  ],
}

export const SEVERAL_COMPANIES: ManualSection = {
  id: 'several-companies',
  title: 'Several Companies',
  summary: 'Send the first email to up to 10 companies in one go: choose them, check the addresses, set the schedule, review, send.',
  blocks: [
    { kind: 'heading', text: 'What it is' },
    {
      kind: 'text',
      text: 'On the Outreach screen, the "Several companies" tab sends the first email to up to 10 companies at once. There are no drafts to open one by one: you check every email on one Review screen, and Send approves them all.',
    },
    {
      kind: 'text',
      text: 'Each email is the approved Version 1, 2 or 3 word for word. Only the company name, the product name, the greeting name and your name and email are filled in — nothing else is written for you.',
    },
    {
      kind: 'warning',
      text: 'The platform never emails a customer itself. When an email is due, you open it in Gmail, send it from your own mailbox, and click "Mark as sent".',
    },

    { kind: 'heading', text: 'Step 1 — Companies and addresses' },
    {
      kind: 'steps',
      items: [
        'Open Outreach, click the "Several companies" tab, then click "New send".',
        'Use the search box to find companies, and tick the ones you want — up to 10.',
        'Check the "Goes to" address under each company. Change it if you know a better address.',
        'Click "Next: schedule".',
      ],
    },
    {
      kind: 'terms',
      items: [
        { term: 'Goes to', meaning: 'The address that company’s email goes to. Underneath it says where it came from: "from Decision Makers", "company mailbox", or "you typed this".' },
        { term: 'nothing was found — type one to include this company', meaning: 'No address was found. Type one to make the company selectable.' },
        { term: 'already in outreach; continue it under One company', meaning: 'This company already has outreach. Carry on with it in the "One company" tab.' },
      ],
    },

    { kind: 'heading', text: 'Step 2 — Schedule' },
    {
      kind: 'terms',
      items: [
        { term: 'Name (optional)', meaning: 'A name to recognise this send. Left empty, it is named with today’s date.' },
        { term: 'First emails due from (your local time)', meaning: 'The earliest time the first email becomes due.' },
        { term: 'Sending time zone', meaning: 'Pick from the list, for example "America/New York". The sending hours are in this time zone.' },
        { term: 'Sending hours from … until', meaning: 'Emails only become due between these times, for example 09:00 to 17:00.' },
        { term: 'Days', meaning: 'Which days emails may become due. Monday to Friday are ticked to begin with.' },
        { term: 'Minutes between companies', meaning: 'The gap between one company’s email and the next (1 to 240).' },
        { term: 'At most per day', meaning: 'The most emails due in one day (1 to 200).' },
      ],
    },
    {
      kind: 'example',
      text: 'You choose 5 companies, first emails due from tomorrow at 09:00, 10 minutes apart. The first is due at 09:00, the second at 09:10, the third at 09:20, and so on.',
    },

    { kind: 'heading', text: 'Step 3 — Review and send' },
    {
      kind: 'steps',
      items: [
        'Click "Next: review". Every company’s email is shown exactly as it will be sent: who it goes to, the version, the subject — and "Show the email" for the full text.',
        'A company marked "Will not be sent" says why. If only the greeting name or the product name is missing, type it in "Greeting name" or "Product name" and click the button beside it.',
        'Tick "I confirm the queries these emails describe were run for each company".',
        'Click "Send". Each email is approved and given its time.',
      ],
    },
    {
      kind: 'tip',
      text: 'Send approves the emails, so it needs an approver or an administrator.',
    },

    { kind: 'heading', text: 'Step 4 — Send each email when it is due' },
    {
      kind: 'steps',
      items: [
        'Open the send. Each email shows "Scheduled" until its time, then "Due now — send it".',
        'Click "Open in Gmail". The email opens with the address, subject and text filled in. Send it from your mailbox.',
        'Click "Mark as sent".',
      ],
    },
    {
      kind: 'text',
      text: 'After that, the company continues under "One company": record replies there, and follow-ups come due on the approved timing (Day 9–10, 12–14, 16–18, 18–20).',
    },

    { kind: 'heading', text: 'The send screen' },
    {
      kind: 'terms',
      items: [
        { term: 'Pause / Resume', meaning: 'Pause stops emails showing as due until you click Resume.' },
        { term: 'Cancel unsent emails', meaning: 'Cancels every email in this send that has not been sent. This cannot be undone.' },
        { term: 'Needs attention', meaning: 'Something changed between Review and Send. Click "Open under One company" to finish that email there.' },
        { term: 'Earlier test run', meaning: 'A test batch from before this screen changed. It can still be opened and read.' },
      ],
    },
  ],
}

export const BULK_EMAIL: ManualSection = {
  id: 'bulk-email',
  title: 'Bulk Email',
  summary: 'Upload an Excel list of contacts; the platform sends the approved template to each company, one email after another, from the date and time you choose (IST).',
  blocks: [
    { kind: 'heading', text: 'What it is' },
    {
      kind: 'text',
      text: 'The "Bulk email" tab on the Outreach screen is its own screen, separate from One company and Several companies: no company selection, nothing from those screens. It sends the approved Static Site email to every contact in an Excel file. Each company gets one email: the first named person receives it, and colleagues from the same company are copied.',
    },
    {
      kind: 'text',
      text: 'The email is the approved template and nothing else. Only [First Name] and [Company Name] are filled in from the Excel file — no AI text, signature or footer is added. The emails are sent from the company mailbox set up on the server.',
    },

    { kind: 'heading', text: 'Why we use it' },
    {
      kind: 'text',
      text: 'To reach a long list of contacts without preparing each email by hand, while still sending them one at a time, a few minutes apart, so they arrive like ordinary emails and not all at once.',
    },

    { kind: 'heading', text: 'Step 1 — Upload the Excel file' },
    {
      kind: 'steps',
      items: [
        'Open Outreach, click the "Bulk email" tab, then "New bulk email".',
        'Click "Choose Excel file" and pick the .xlsx file. The first sheet is read.',
        'Check the list: each company, who it goes to, and who is copied. Companies whose Status says "not interested" or "Outreach - <date>" are skipped and say so.',
        'Click "Next: review emails".',
      ],
    },
    {
      kind: 'terms',
      items: [
        { term: 'Work email only', meaning: 'Only the "Primary" or company address is used. Addresses marked "Personal", or on gmail, yahoo, comcast and similar, are not emailed — unless you tick the test option to include them, for a first test with your own team’s addresses.' },
        { term: 'One email per company', meaning: 'Several people from the same company — on one row or several rows — receive one email: the first is the recipient, the others are in CC.' },
      ],
    },

    { kind: 'heading', text: 'Step 2 — Review the emails' },
    {
      kind: 'steps',
      items: [
        'You see how many emails will be sent and how many are skipped, and every company with its To and CC.',
        'Click "Preview" on any company to read its email exactly as it will be sent.',
        'Click "Next: date and time".',
      ],
    },

    { kind: 'heading', text: 'Step 3 — Date, time and minutes between emails' },
    {
      kind: 'terms',
      items: [
        { term: 'Date', meaning: 'The day the first email goes.' },
        { term: 'Time (IST)', meaning: 'When the first email goes, in Indian Standard Time. Times are shown in 12-hour AM/PM.' },
        { term: 'Minutes between emails', meaning: 'The gap between one email and the next. For example 10:00 AM and 5 minutes: 10:00, 10:05, 10:10, 10:15 … until the whole list is sent.' },
      ],
    },
    {
      kind: 'steps',
      items: [
        'Check the list of sending times and the time of the last email. If you change the date, time or minutes, click "Show the sending times" again.',
        'Tick the confirmation and click "Approve and start sending". This needs an approver or an administrator.',
      ],
    },

    { kind: 'heading', text: 'While it runs' },
    {
      kind: 'terms',
      items: [
        { term: 'Scheduled / Sending / Sent / Failed / Skipped', meaning: 'Where each email is. A failed email shows the reason; the others carry on.' },
        { term: 'Pause / Resume', meaning: 'Pause stops sending. Resume carries on from now, still the same minutes apart.' },
        { term: 'Cancel unsent', meaning: 'Stops the send; emails not yet sent are skipped.' },
        { term: 'Unsubscribe', meaning: 'When someone replies "unsubscribe", click this beside them. They are never emailed again.' },
        { term: 'Bulk sequence completed', meaning: 'Shown when every email has been processed, with the totals sent, failed and skipped.' },
      ],
    },

    { kind: 'heading', text: 'What to do next' },
    {
      kind: 'text',
      text: 'Watch the mailbox for replies. Reply to interested contacts yourself, and click Unsubscribe for anyone who asks not to be contacted.',
    },
  ],
}


export const TROUBLESHOOTING: ManualSection = {
  id: 'troubleshooting',
  title: 'Troubleshooting',
  summary: 'Common problems, what they mean, and what to do.',
  blocks: [
    { kind: 'heading', text: 'General' },
    {
      kind: 'terms',
      items: [
        { term: 'I can’t see a button this manual mentions', meaning: 'Your role probably does not include it (see Getting Started → Your role). Ask an administrator.' },
        { term: 'Something stays "Queued" for more than a minute', meaning: 'The background service is probably not running. Tell your administrator — it cannot be fixed from the screen.' },
        { term: '"The connection to the Marketing AI service was lost"', meaning: 'Your internet connection dropped or changed (Wi-Fi, hotspot or VPN). Check your connection and click "Try again" — nothing is lost. If it continues while your internet works, tell your administrator.' },
        { term: 'The right-hand panel is missing', meaning: 'On a smaller window it hides itself. Click the panel button in the top bar ("Show company context").' },
        { term: '"No company selected" / "Select a company"', meaning: 'Choose a company first — click "Select" in Prospects, or pick one in the Shared context panel.' },
      ],
    },

    { kind: 'heading', text: 'Prospects' },
    {
      kind: 'terms',
      items: [
        { term: '"No company found"', meaning: 'The search ran but found nothing it could check. Try describing the companies differently — another wording, a wider area, or a different kind of business.' },
        { term: '"This search did not finish"', meaning: 'The search failed. The reason is shown. Search again.' },
        { term: 'Many companies under "Could not be checked"', meaning: 'Their websites could not be opened, or were outside the area you asked for. The reason is shown for each one.' },
        { term: 'A company is under "Review manually"', meaning: 'Its website blocks automatic reading. Click the product link and look at the page yourself.' },
      ],
    },

    { kind: 'heading', text: 'Enrichment and Intent Signals' },
    {
      kind: 'terms',
      items: [
        { term: 'Enrichment says "Blocked"', meaning: 'The company has no website on record. Add the website to the company in NXT Sales and run enrichment again.' },
        { term: 'Enrichment says "Partial"', meaning: 'The website could not be read, or it sent us to a different website. Check the website address on record.' },
        { term: 'Intent says "No Stage 2 enrichment exists for this company yet"', meaning: 'Run Enrichment first, then "Detect again".' },
        { term: '"No qualifying signals observed"', meaning: 'Not an error — nothing relevant was found. You can still contact the company.' },
      ],
    },

    { kind: 'heading', text: 'Decision Makers' },
    {
      kind: 'terms',
      items: [
        { term: '"Nobody verified yet"', meaning: 'No person could be proved to work at this company in the right role. Run it again later, or use Several Companies and type an address you found yourself.' },
        { term: 'A person but no email', meaning: 'Type the address yourself in Outreach, in the "Goes to" box.' },
      ],
    },

    { kind: 'heading', text: 'Outreach' },
    {
      kind: 'terms',
      items: [
        { term: '"Outreach cannot start yet — no decision maker"', meaning: 'Run Decision Makers for this company first.' },
        { term: '"The sender is not set up"', meaning: 'Every email is signed with your name and the company name. An administrator sets the company name in Settings → Outreach sender. If your own name is missing, ask an administrator.' },
        { term: '"Not filled yet: [product]…"', meaning: 'Fill the gap. For [product], type it in the "Product" box under "Values from Sales" and click "Save values". For [name], type the name over "[Name]" in the Body and click "Save changes".' },
        { term: 'Approve is greyed out', meaning: 'Hover over it. "Complete the checklist first" — fix the crosses in "Before approval". "Save your changes first" — click "Save changes".' },
        { term: '"Approval is made by someone with approval permission."', meaning: 'Your role cannot approve. Ask a colleague with approval rights.' },
        { term: '"Confirmed N days ago; the email says "this week", so confirm it again."', meaning: 'Your confirmation is more than 7 days old. Re-run the check and tick the Sales confirmation again.' },
        { term: '"The company is not suppressed" has a cross', meaning: 'The company is blocked — for example it has an open deal in NXT Sales, was contacted in the last 30 days, or is on the do-not-contact list. The reason is shown. Do not email them.' },
        { term: '"Open in Gmail" opens the wrong account', meaning: 'Switch to the right account in Gmail first, then click "Open in Gmail" again.' },
        { term: '"Other mail app" does nothing', meaning: 'Your computer has no email program set up. Use "Open in Gmail" instead.' },
        { term: '"This browser would not let the page copy for you"', meaning: 'Select the text in the boxes yourself and copy it, or use "Open in Gmail".' },
        { term: '"The email changed after it was approved. Review and approve it again."', meaning: 'Something was edited after approval. Approve it again, then mark it as sent.' },
        { term: 'No follow-ups are coming due', meaning: 'Check the first email was marked as sent. Follow-up dates are counted from "Mark as sent".' },
        { term: '"Replies can be recorded once the initial email has been marked sent."', meaning: 'Mark the first email as sent before pasting a reply.' },
        { term: 'I clicked "Stop sequence" by mistake', meaning: 'A stopped sequence cannot be resumed from the screen. Ask your administrator for help.' },
      ],
    },

    { kind: 'heading', text: 'Several Companies' },
    {
      kind: 'terms',
      items: [
        { term: 'I can’t tick a company', meaning: 'Its "Goes to" box needs a proper email address, or the company is already in outreach (continue it under One company).' },
        { term: 'A company I expected is not listed', meaning: 'Only companies that have been through Decision Makers are listed. Run Decision Makers for it first.' },
        { term: '"Will not be sent" on the Review screen', meaning: 'The reason is shown under the company. Fix it (for example type the greeting name), or leave it out — the others are still sent.' },
        { term: 'The Send button is greyed out', meaning: 'Tick the confirmation first. Sending also needs an approver or an administrator.' },
        { term: 'An email stays "Scheduled"', meaning: 'Its time has not come yet, or the send is paused. It shows "Due now" at its time.' },
      ],
    },

    { kind: 'heading', text: 'Still stuck?' },
    {
      kind: 'text',
      text: 'Every error box shows "To resolve" with a suggestion. If the problem continues, tell your administrator what you were doing, which company it was, and the exact message on screen.',
    },
  ],
}
