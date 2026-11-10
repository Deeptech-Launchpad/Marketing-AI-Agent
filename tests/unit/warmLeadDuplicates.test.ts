import { describe, expect, it } from 'vitest'
import { classify, type EvaluationInput, type ObservedSignal, type WebsiteObservation } from '../../src/warmleads/score.js'

// PR #10 review: duplicate and republished evidence, in any language, with light rewording, without merging real developments.
// The rule being protected: one event is counted once; a genuinely different development is counted; both are explainable.

const sig = (over: Partial<ObservedSignal>): ObservedSignal => ({
  signalType: 'public_business_activity',
  signalCategory: 'business',
  polarity: 'positive',
  confidence: 'high',
  freshness: 'fresh',
  status: 'active',
  summary: 'x',
  evidence: 'quoted',
  sourceUrl: 'https://a.example/1',
  observedAt: '2026-11-01',
  ...over,
})
const site = (over: Partial<WebsiteObservation> = {}): WebsiteObservation => ({ status: 'reachable', url: 'https://x.example/', hasProductSchema: false, commercePlatforms: ['Shopify'], ...over })
const run = (signals: ObservedSignal[], website: WebsiteObservation = site()) => {
  const input: EvaluationInput = { crm: { ok: true, signals: [] }, website, deep: { status: 'done', signals } }
  return classify(input)
}
const counted = (r: ReturnType<typeof run>) => r.reasons.filter((x) => x.source === 'web_research' && x.points > 0).length
const merged = (r: ReturnType<typeof run>) => r.reasons.filter((x) => /counted once/.test(x.summary)).length
/** Two records of one story on two different sites a day apart. */
const twice = (first: string, second: string, over: Partial<ObservedSignal> = {}) => [sig({ summary: first, ...over }), sig({ summary: second, sourceUrl: 'https://b.example/2', observedAt: '2026-11-02', ...over })]

describe('H4 - the same story is one event in any language', () => {
  const stories: Array<[string, string, string]> = [
    ['English', 'Acme opened a new warehouse in Pune to expand its product catalogue distribution', 'Acme opened a new warehouse in Pune to expand its product catalogue distribution, reports say'],
    ['Hindi', 'एक्मे ने पुणे में नया गोदाम खोला है ताकि उत्पाद सूची का वितरण बढ़ाया जा सके', 'एक्मे ने पुणे में नया गोदाम खोला है ताकि उत्पाद सूची का वितरण बढ़ाया जा सके, रिपोर्ट'],
    ['Chinese', 'Acme在上海开设新仓库并扩大产品目录', 'Acme在上海开设新仓库并扩大产品目录，媒体报道'],
    ['German', 'Acme hat in Köln ein neues Lager eröffnet um den Katalogvertrieb zu erweitern', 'Acme hat in Köln ein neues Lager eröffnet um den Katalogvertrieb zu erweitern, berichtet'],
    ['French', 'Acme a ouvert un nouvel entrepôt à Lyon pour étendre la distribution de son catalogue', 'Acme a ouvert un nouvel entrepôt à Lyon pour étendre la distribution de son catalogue, selon la presse'],
    ['Japanese', 'Acmeは大阪に新しい倉庫を開設し製品カタログの配送を拡大した', 'Acmeは大阪に新しい倉庫を開設し製品カタログの配送を拡大した、と報道'],
    ['Russian', 'Acme открыла новый склад в Москве чтобы расширить распространение каталога', 'Acme открыла новый склад в Москве чтобы расширить распространение каталога, сообщают СМИ'],
  ]
  it.each(stories)('%s: two sites, a day apart - counted once, so a fit-only company stays an early signal', (_lang, first, second) => {
    for (const order of [twice(first, second), twice(first, second).reverse()]) {
      const r = run(order)
      expect(counted(r), 'events counted').toBe(1)
      expect(merged(r), 'listed as the same event').toBe(1)
      expect(r.score).toBe(35)
      expect(r.classification).toBe('early_signal')
    }
  })
  it('a different Hindi / Chinese story is still its own event', () => {
    expect(counted(run(twice('एक्मे ने पुणे में नया गोदाम खोला है ताकि उत्पाद सूची का वितरण बढ़ाया जा सके', 'ग्लोबेक्स के साथ वितरण समझौते पर हस्ताक्षर किए गए जिससे कंपनी की बिक्री बढ़ेगी')))).toBe(2)
    expect(counted(run(twice('Acme在上海开设新仓库并扩大产品目录', 'Acme获得新一轮融资并聘请五十名工程师')))).toBe(2)
  })
  it('a different number in a non-English summary is a different event', () => {
    expect(counted(run(twice('एक्मे ने 5 नए इंजीनियर नियुक्त किए हैं उत्पाद सूची विभाग के लिए', 'एक्मे ने 50 नए इंजीनियर नियुक्त किए हैं उत्पाद सूची विभाग के लिए')))).toBe(2)
  })
})

describe('H5 - lightly reworded retellings are still the same event', () => {
  it('extra detail on one side is not a different fact ("Acme Corp ... Pune, India" / "Acme ... Pune, Maharashtra")', () => {
    const r = run(twice('Acme Corp opens a warehouse in Pune, India to expand product catalogue distribution', 'Acme opens a warehouse in Pune, Maharashtra to expand product catalogue distribution'))
    expect(counted(r)).toBe(1)
    expect(r.score).toBe(35)
  })
  it('tense and word form do not matter (opens / opened, expand / expanding, warehouse / warehouses)', () => {
    expect(counted(run(twice('Acme opens new warehouse in Pune to expand product catalogue', 'Acme opened a new warehouse in Pune, expanding its product catalogue')))).toBe(1)
    expect(counted(run(twice('Acme launches new warehouses for its product catalogue in Pune', 'Acme launched a new warehouse for its product catalogues in Pune')))).toBe(1)
  })
  it('a different name in the same place of the sentence is a different development, not detail', () => {
    for (const [a, b] of [
      ['Pune warehouse opened by Acme to expand product catalogue distribution', 'Delhi warehouse opened by Acme to expand product catalogue distribution'],
      ['Acme opened a new warehouse in Pune to expand product catalogue distribution', 'Acme opened a new warehouse in Delhi to expand product catalogue distribution'],
      ['Acme signed a distribution agreement with Globex Retail for respiratory devices', 'Acme signed a distribution agreement with Initech Retail for respiratory devices'],
      ['Acme opened a warehouse in Pune, India to expand product catalogue distribution', 'Acme opened a warehouse in Delhi, India to expand product catalogue distribution'],
      ['Globex opened a new warehouse to expand product catalogue distribution in Pune', 'Initech opened a new warehouse to expand product catalogue distribution in Pune'],
    ] as const) {
      const r = run(twice(a, b))
      expect(counted(r), a).toBe(2)
      expect(merged(r), a).toBe(0)
      expect(r.classification).toBe('warm')
    }
  })
})

describe('M6 - different developments are not merged on a first word, a number or an unusual name', () => {
  it('"Pune warehouse ..." / "Delhi warehouse ...": the first word is a fact too', () => {
    expect(counted(run(twice('Pune warehouse opened by Acme to expand product catalogue distribution', 'Delhi warehouse opened by Acme to expand product catalogue distribution')))).toBe(2)
  })
  it('"50 staff" / "5 staff", and a number against no number is detail only', () => {
    expect(counted(run(twice('50 warehouse staff hired by Acme to expand product catalogue distribution', '5 warehouse staff hired by Acme to expand product catalogue distribution')))).toBe(2)
    expect(counted(run(twice('Acme hired 50 warehouse staff to expand product catalogue distribution', 'Acme hired warehouse staff to expand product catalogue distribution')))).toBe(1)
  })
  it('an all-capitals or digit-bearing name counts as a fact (ISO9001, AWFS, 5G)', () => {
    expect(counted(run(twice('Acme earned ISO9001 certification for its product catalogue distribution centre', 'Acme earned ISO14001 certification for its product catalogue distribution centre')))).toBe(2)
    expect(counted(run(twice('Acme joined AWFS as a member to expand product catalogue distribution', 'Acme joined NAHB as a member to expand product catalogue distribution')))).toBe(2)
  })
})

describe('M7 - one page, one day: only the same thing is one event', () => {
  const page = 'https://acme.example/news'
  it('two different announcements on one page on one day are two events', () => {
    const r = run([sig({ summary: 'Acme launched a Shopify store for its catalogue', sourceUrl: page }), sig({ summary: 'Acme signed a distribution agreement with Globex', sourceUrl: page })], site({ commercePlatforms: [] }))
    expect(counted(r)).toBe(2)
    expect(merged(r)).toBe(0)
  })
  it('articles told apart only by a query parameter are different pages; tracking parameters are not', () => {
    const a = (id: string) => sig({ summary: 'Acme launched a Shopify store for its catalogue', sourceUrl: `https://acme.example/news.aspx?id=${id}` })
    expect(counted(run([a('101'), sig({ summary: 'Acme signed a distribution agreement with Globex', sourceUrl: 'https://acme.example/news.aspx?id=102' })], site({ commercePlatforms: [] })))).toBe(2)
    // the same article with tracking parameters, a fragment, www and a trailing slash is one page
    const same = run([a('101'), sig({ summary: 'Acme launched a Shopify store for its catalogue range', sourceUrl: 'http://www.acme.example/news.aspx/?id=101&utm_source=x#top' })], site({ commercePlatforms: [] }))
    expect(counted(same)).toBe(1)
    expect(merged(same)).toBe(1)
  })
  it('the same announcement recorded twice on one page is still one event (the Pro Safety case)', () => {
    const r = run([sig({ summary: 'ProSafety officially became a CleanSpace service center.', sourceUrl: 'https://prosafety.com/en/blog' }), sig({ summary: 'ProSafety officially became a CleanSpace service center to monitor respiratory devices.', sourceUrl: 'https://prosafety.com/en/blog/' })])
    expect(counted(r)).toBe(1)
  })
})

describe('M8 - negative news is deduplicated before it is charged', () => {
  const neg = (url: string, summary = 'Acme reported layoffs and a closed plant', over: Partial<ObservedSignal> = {}) => sig({ polarity: 'negative', signalType: 'layoffs', summary, sourceUrl: url, ...over })
  const positive = sig({ summary: 'Acme opened a new warehouse', sourceUrl: 'https://p.example/1' })
  it('three sites reporting one layoff cost one penalty, not three', () => {
    const one = run([positive, neg('https://n1.example/a')])
    const three = run([positive, neg('https://n1.example/a'), neg('https://n2.example/b'), neg('https://n3.example/c')])
    expect(three.score).toBe(one.score)
    expect(three.reasons.filter((x) => x.polarity === 'negative' && x.points < 0)).toHaveLength(1)
    expect(three.reasons.filter((x) => x.polarity === 'negative' && x.points === 0 && /counted once/.test(x.summary))).toHaveLength(2)
    expect(three.classification).toBe('early_signal')
  })
  it('two different bad developments are two penalties', () => {
    const r = run([positive, neg('https://n1.example/a', 'Acme laid off 40 staff at its Pune plant'), neg('https://n2.example/b', 'Acme lost its main distributor Globex', { signalType: 'lost_customer' })])
    expect(r.reasons.filter((x) => x.polarity === 'negative' && x.points < 0)).toHaveLength(2)
  })
  it('a positive and a negative story with the same words are never one event', () => {
    const r = run([sig({ summary: 'Acme closed its Pune warehouse', sourceUrl: 'https://a.example/1' }), sig({ summary: 'Acme closed its Pune warehouse', polarity: 'negative', sourceUrl: 'https://b.example/2', observedAt: '2026-11-02' })])
    expect(r.reasons.filter((x) => /counted once/.test(x.summary))).toHaveLength(0)
  })
})

describe('second review - what makes one story look like two, and what must not', () => {
  const same = (a: string, b: string, label = a) => {
    const r = run(twice(a, b))
    expect(counted(r), label).toBe(1)
    expect(r.score, label).toBe(35)
  }
  const different = (a: string, b: string, label = a) => {
    const r = run(twice(a, b))
    expect(counted(r), label).toBe(2)
    expect(r.classification, label).toBe('warm')
  }
  const BASE = 'ProSafety officially became a CleanSpace service center for respiratory devices'

  it('E1 - who reported it is not a fact (outlet, spokesperson, "X reports")', () => {
    same(`${BASE}, according to Reuters`, `${BASE}, according to Bloomberg`)
    same(`Economic Times reports Acme opened a new warehouse in Pune to expand catalogue distribution`, `Mint reports Acme opened a new warehouse in Pune to expand catalogue distribution`)
    same(`Reuters: Acme opened a new warehouse in Pune to expand catalogue distribution`, `Bloomberg: Acme opened a new warehouse in Pune to expand catalogue distribution`)
    same(`Acme opened a new warehouse in Pune to expand catalogue distribution, said Rahul Sharma`, `Acme opened a new warehouse in Pune to expand catalogue distribution, said Priya Nair`)
  })

  it('E1b - a headline\'s outlet suffix after a spaced hyphen, dash or pipe is not a fact either (the common feed format)', () => {
    const S = 'Acme opened a new warehouse in Pune to expand product catalogue distribution'
    same(`${S} - Reuters`, `${S} - Bloomberg`)
    same(`${S} | Reuters`, `${S} | Bloomberg`)
    same(`${S} – The Economic Times`, `${S} – Mint`)
    same(`${S} - Moneycontrol`, `${S} - Business Standard`)
    same(`${S} (Reuters)`, `${S} (Bloomberg)`)
    // ... but a different place or number in the body is still a different development, whatever the outlet
    different(`Acme opened a new warehouse in Pune to expand product catalogue distribution - Reuters`, `Acme opened a new warehouse in Delhi to expand product catalogue distribution - Reuters`)
    different(`Acme hired 50 engineers for its catalogue distribution warehouse in Pune | Mint`, `Acme hired 500 engineers for its catalogue distribution warehouse in Pune | Mint`)
  })

  it('E1 - the form of a company name, a spelling variant and a headline in Title Case are not facts', () => {
    same('Acme Corp opened a new warehouse in Pune to expand catalogue distribution', 'Acme Corporation opened a new warehouse in Pune to expand catalogue distribution')
    same('Acme Ltd opened a new warehouse in Pune to expand catalogue distribution', 'Acme Limited opened a new warehouse in Pune to expand catalogue distribution')
    same('Acme Pvt Ltd opened a new warehouse in Pune to expand catalogue distribution', 'Acme Private Limited opened a new warehouse in Pune to expand catalogue distribution')
    same('Acme opened a new Distribution Centre in Pune to serve retailers nationwide', 'Acme opened a new Distribution Center in Pune to serve retailers nationwide')
    same('Acme Opens New Warehouse In Pune To Expand Catalogue Distribution', 'Acme Launches New Warehouse In Pune To Expand Catalogue Distribution')
    same('İstanbul warehouse opened by Acme to expand product catalogue distribution', 'Istanbul warehouse opened by Acme to expand product catalogue distribution')
  })

  it('E2 - the way a number or a date is written is not a fact', () => {
    same('Acme invested 1,000 crore to open a warehouse in Pune for catalogue distribution', 'Acme invested 1000 crore to open a warehouse in Pune for catalogue distribution')
    same('Acme raised 5 million to open a warehouse in Pune for catalogue distribution', 'Acme raised 5M to open a warehouse in Pune for catalogue distribution')
    same('On October 23 Acme opened a new warehouse in Pune for catalogue distribution', 'On 23rd October Acme opened a new warehouse in Pune for catalogue distribution')
    same('On 23 Oct Acme opened a new warehouse in Pune for catalogue distribution', 'On 24 Oct Acme opened a new warehouse in Pune for catalogue distribution')
    same('On Monday Acme opened a new warehouse in Pune for catalogue distribution', 'On Tuesday Acme opened a new warehouse in Pune for catalogue distribution')
    same('Acme hired five engineers for its catalogue distribution warehouse in Pune', 'Acme hired 5 engineers for its catalogue distribution warehouse in Pune')
  })

  it('E2 - but a different figure IS a different development, in any digits', () => {
    different('Acme hired 50 engineers for its catalogue distribution warehouse in Pune', 'Acme hired 500 engineers for its catalogue distribution warehouse in Pune')
    different('Acme raised 5 million to open a warehouse in Pune for catalogue distribution', 'Acme raised 50 million to open a warehouse in Pune for catalogue distribution')
    different('Acme hired two engineers for its catalogue distribution warehouse in Pune', 'Acme hired three engineers for its catalogue distribution warehouse in Pune')
    different('एक्मे ने ५० नए इंजीनियर नियुक्त किए हैं उत्पाद सूची विभाग के लिए', 'एक्मे ने १०० नए इंजीनियर नियुक्त किए हैं उत्पाद सूची विभाग के लिए')
    different('Acme opened its second warehouse in Pune to expand catalogue distribution', 'Acme opened its third warehouse in Pune to expand catalogue distribution')
  })

  it('E3 - a short version of a long retelling is the same event; two very short ones with the same words too', () => {
    same('Acme opened a new warehouse in Pune', 'Acme opened a new warehouse in Pune, which will serve retailers across Maharashtra and shorten delivery times for customers')
    same('ProSafety became a CleanSpace service center', 'ProSafety officially became a CleanSpace service center for respiratory devices in Germany, the company said on its blog')
    same('Acme opens warehouse', 'Acme opened warehouse')
  })

  it('B7 - a different name is found whichever word comes before it (in / at / near / into), and a letter or an ordinal is a name', () => {
    different('Acme opened a new warehouse in Pune to expand catalogue distribution', 'Acme opened a new warehouse at Delhi to expand catalogue distribution')
    different('Acme opened a new warehouse in Pune to expand catalogue distribution', 'Acme opened a new warehouse near Delhi to expand catalogue distribution')
    different('Acme expands to Pune with a new warehouse for catalogue distribution', 'Acme expands into Delhi with a new warehouse for catalogue distribution')
    different('Acme raised a Series A round to expand its catalogue distribution warehouse', 'Acme raised a Series B round to expand its catalogue distribution warehouse')
  })

  it('B9 - a generic copy cannot bridge two specific ones on the same page and day', () => {
    const page = 'https://acme.example/news'
    const generic = sig({ summary: 'Acme opened a new warehouse for product catalogue distribution', sourceUrl: page })
    const pune = sig({ summary: 'Acme opened a new warehouse in Pune for product catalogue distribution', sourceUrl: page })
    const delhi = sig({ summary: 'Acme opened a new warehouse in Delhi for product catalogue distribution', sourceUrl: page })
    for (const order of [[generic, pune, delhi], [pune, generic, delhi], [delhi, pune, generic]]) expect(counted(run(order))).toBe(2)
  })

  it('page normalisation is what separates two pages: a pair similar enough only for the same-page rule', () => {
    // 3 shared words of 8: similar for ONE page, not the same story across two pages
    const one = (url: string) => sig({ summary: 'Acme launched shopify store catalogue today', sourceUrl: url })
    const two = (url: string) => sig({ summary: 'Acme launched shopify store with retailers nationwide', sourceUrl: url })
    expect(counted(run([one('https://acme.example/news'), two('https://acme.example/news')], site({ commercePlatforms: [] })))).toBe(1)
    expect(counted(run([one('https://acme.example/news'), two('https://other.example/news')], site({ commercePlatforms: [] })))).toBe(2)
    expect(counted(run([one('https://acme.example/news?id=1'), two('https://acme.example/news?id=2')], site({ commercePlatforms: [] })))).toBe(2)
    expect(counted(run([one('https://acme.example/#/news/1'), two('https://acme.example/#/news/2')], site({ commercePlatforms: [] })))).toBe(2)
  })

  it('the listing, not only the score, is the same in every order - including which copy is kept when nothing else tells them apart', () => {
    const a = sig({ summary: 'Acme opened a new warehouse in Pune to expand product catalogue distribution', sourceUrl: 'https://a.example/1' })
    const b = sig({ summary: 'Acme opened a new warehouse in Pune to expand product catalogue distribution', sourceUrl: 'https://www.a.example/1?utm_source=x' })
    const listing = (signals: ObservedSignal[]) => JSON.stringify(run(signals).reasons.map((x) => [x.sourceUrl, x.points]).sort())
    expect(listing([a, b])).toBe(listing([b, a]))
  })

  it('malformed input does not crash the classification', () => {
    const odd = sig({ summary: undefined as unknown as string, evidence: undefined as unknown as string, sourceUrl: 42 as unknown as string })
    expect(() => run([odd, sig({ summary: 'Acme opened a warehouse in Pune' })])).not.toThrow()
  })
})

describe('the result does not depend on order, and the evidence stays explainable', () => {
  const set = [
    sig({ summary: 'Acme opened a new warehouse in Pune to expand product catalogue distribution', sourceUrl: 'https://a.example/1' }),
    sig({ summary: 'Acme opened a new warehouse in Pune, expanding its product catalogue distribution', sourceUrl: 'https://b.example/2', observedAt: '2026-11-02' }),
    sig({ summary: 'Acme opened a new warehouse in Delhi to expand product catalogue distribution', sourceUrl: 'https://c.example/3', observedAt: '2026-11-02' }),
    sig({ summary: 'एक्मे ने पुणे में नया गोदाम खोला है ताकि उत्पाद सूची का वितरण बढ़ाया जा सके', sourceUrl: 'https://d.example/4' }),
    sig({ polarity: 'negative', signalType: 'layoffs', summary: 'Acme reported layoffs', sourceUrl: 'https://e.example/5' }),
    sig({ polarity: 'negative', signalType: 'layoffs', summary: 'Acme reported layoffs and a closed plant', sourceUrl: 'https://f.example/6' }),
  ]
  it('every ordering of the same evidence gives the same score and the same listing', () => {
    const key = (r: ReturnType<typeof run>) => JSON.stringify({ s: r.score, c: r.classification, p: r.reasons.map((x) => `${x.summary}|${x.points}`).sort() })
    const first = key(run(set))
    let seed = 7
    for (let i = 0; i < 40; i++) {
      const shuffled = [...set]
      for (let j = shuffled.length - 1; j > 0; j--) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        const k = seed % (j + 1)
        ;[shuffled[j], shuffled[k]] = [shuffled[k]!, shuffled[j]!]
      }
      expect(key(run(shuffled))).toBe(first)
    }
  })
  it('a folded-in signal is listed with 0 points and says it was counted once, and the input is not changed', () => {
    const before = JSON.stringify(set)
    const r = run(set)
    expect(JSON.stringify(set)).toBe(before)
    expect(r.reasons.filter((x) => /counted once/.test(x.summary)).every((x) => x.points === 0 && x.sourceUrl)).toBe(true)
  })
  it('a large batch of near-identical signals is compared quickly', () => {
    const many = Array.from({ length: 300 }, (_, i) => sig({ summary: ('Acme opened a new warehouse in Pune to expand product catalogue distribution ' + 'across the region '.repeat(8)).trim() + ` ${i % 5}`, sourceUrl: `https://s${i}.example/x`, observedAt: `2026-11-0${1 + (i % 3)}` }))
    const t = Date.now()
    run(many)
    expect(Date.now() - t).toBeLessThan(3000)
  })
})
