// ZONES: the NXT Sales company list is worked through one region at a time.
//
// Owner's decision (2026-11-26): six zones plus "unknown" for a company whose country NXT Sales does not hold or
// that cannot be recognised. A company's zone is derived from its NXT Sales country every time the list is read,
// so correcting a country in NXT Sales moves the company on the next read. Pure functions; nothing here reads a
// database or the network.

export const ZONES = ['india', 'middle_east', 'europe', 'north_america', 'asia_pacific', 'rest_of_world', 'unknown'] as const
export type Zone = (typeof ZONES)[number]

export const ZONE_LABELS: Record<Zone, string> = {
  india: 'India',
  middle_east: 'Middle East (GCC)',
  europe: 'Europe & UK',
  north_america: 'North America',
  asia_pacific: 'Asia-Pacific',
  rest_of_world: 'Rest of world',
  unknown: 'Unknown country',
}

export const isZone = (v: unknown): v is Zone => typeof v === 'string' && (ZONES as readonly string[]).includes(v)

// Country names, ISO 3166 alpha-2 and alpha-3 codes and the spellings seen in sales data, folded (lower case, letters
// and spaces only). Only the countries listed are placed; anything else that is a real word is "rest_of_world" only
// when it is listed there - an unrecognised value is "unknown", never guessed.
const TABLE: Record<Exclude<Zone, 'unknown'>, string[]> = {
  india: ['india', 'in', 'ind', 'bharat', 'republic of india'],
  middle_east: [
    'united arab emirates', 'uae', 'ae', 'are', 'u a e', 'emirates', 'dubai', 'abu dhabi', 'sharjah',
    'saudi arabia', 'kingdom of saudi arabia', 'ksa', 'sa', 'sau',
    'qatar', 'qa', 'qat', 'kuwait', 'kw', 'kwt', 'bahrain', 'bh', 'bhr', 'oman', 'om', 'omn',
    'jordan', 'jo', 'jor', 'lebanon', 'lb', 'lbn', 'israel', 'il', 'isr', 'iraq', 'iq', 'irq', 'iran', 'ir', 'irn',
    'yemen', 'ye', 'yem', 'syria', 'sy', 'syr', 'palestine', 'ps', 'pse', 'egypt', 'eg', 'egy', 'turkey', 'turkiye', 'tr', 'tur',
  ],
  europe: [
    'united kingdom', 'uk', 'gb', 'gbr', 'great britain', 'britain', 'england', 'scotland', 'wales', 'northern ireland',
    'ireland', 'ie', 'irl', 'germany', 'de', 'deu', 'france', 'fr', 'fra', 'italy', 'it', 'ita', 'spain', 'es', 'esp',
    'portugal', 'pt', 'prt', 'netherlands', 'the netherlands', 'holland', 'nl', 'nld', 'belgium', 'be', 'bel',
    'luxembourg', 'lu', 'lux', 'switzerland', 'ch', 'che', 'austria', 'at', 'aut', 'denmark', 'dk', 'dnk',
    'sweden', 'se', 'swe', 'norway', 'no', 'nor', 'finland', 'fi', 'fin', 'iceland', 'is', 'isl', 'poland', 'pl', 'pol',
    'czech republic', 'czechia', 'cz', 'cze', 'slovakia', 'sk', 'svk', 'hungary', 'hu', 'hun', 'romania', 'ro', 'rou',
    'bulgaria', 'bg', 'bgr', 'greece', 'gr', 'grc', 'cyprus', 'cy', 'cyp', 'malta', 'mt', 'mlt', 'croatia', 'hr', 'hrv',
    'slovenia', 'si', 'svn', 'serbia', 'rs', 'srb', 'bosnia and herzegovina', 'ba', 'bih', 'montenegro', 'me', 'mne',
    'north macedonia', 'macedonia', 'mk', 'mkd', 'albania', 'al', 'alb', 'estonia', 'ee', 'est', 'latvia', 'lv', 'lva',
    'lithuania', 'lt', 'ltu', 'ukraine', 'ua', 'ukr', 'belarus', 'by', 'blr', 'moldova', 'md', 'mda', 'russia',
    'russian federation', 'ru', 'rus', 'monaco', 'mc', 'liechtenstein', 'li', 'andorra', 'ad', 'san marino', 'sm',
  ],
  north_america: ['united states', 'united states of america', 'usa', 'us', 'u s', 'u s a', 'america', 'canada', 'ca', 'can', 'mexico', 'mx', 'mex'],
  asia_pacific: [
    'china', 'cn', 'chn', 'peoples republic of china', 'hong kong', 'hk', 'hkg', 'taiwan', 'tw', 'twn', 'japan', 'jp', 'jpn',
    'south korea', 'korea', 'republic of korea', 'kr', 'kor', 'singapore', 'sg', 'sgp', 'malaysia', 'my', 'mys',
    'indonesia', 'id', 'idn', 'thailand', 'th', 'tha', 'vietnam', 'viet nam', 'vn', 'vnm', 'philippines', 'ph', 'phl',
    'australia', 'au', 'aus', 'new zealand', 'nz', 'nzl', 'sri lanka', 'lk', 'lka', 'bangladesh', 'bd', 'bgd',
    'nepal', 'np', 'npl', 'bhutan', 'bt', 'btn', 'maldives', 'mv', 'mdv', 'pakistan', 'pk', 'pak', 'myanmar', 'mm', 'mmr',
    'cambodia', 'kh', 'khm', 'laos', 'la', 'lao', 'brunei', 'bn', 'brn', 'mongolia', 'mn', 'mng', 'macau', 'macao', 'mo',
  ],
  rest_of_world: [
    'brazil', 'br', 'bra', 'argentina', 'ar', 'arg', 'chile', 'cl', 'chl', 'colombia', 'co', 'col', 'peru', 'pe', 'per',
    'venezuela', 've', 'ven', 'ecuador', 'ec', 'ecu', 'uruguay', 'uy', 'ury', 'paraguay', 'py', 'pry', 'bolivia', 'bo', 'bol',
    'south africa', 'za', 'zaf', 'nigeria', 'ng', 'nga', 'kenya', 'ke', 'ken', 'ghana', 'gh', 'gha', 'morocco', 'ma', 'mar',
    'algeria', 'dz', 'dza', 'tunisia', 'tn', 'tun', 'ethiopia', 'et', 'eth', 'tanzania', 'tz', 'tza', 'uganda', 'ug', 'uga',
    'kazakhstan', 'kz', 'kaz', 'uzbekistan', 'uz', 'uzb', 'afghanistan', 'af', 'afg', 'costa rica', 'cr', 'cri',
    'panama', 'pa', 'pan', 'guatemala', 'gt', 'gtm', 'dominican republic', 'do', 'dom', 'jamaica', 'jm', 'jam',
    'mauritius', 'mu', 'mus', 'zimbabwe', 'zw', 'zwe', 'zambia', 'zm', 'zmb', 'namibia', 'na', 'nam', 'botswana', 'bw', 'bwa',
  ],
}

const fold = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const LOOKUP = new Map<string, Zone>()
for (const [zone, names] of Object.entries(TABLE) as Array<[Zone, string[]]>) for (const n of names) LOOKUP.set(fold(n), zone)

/** The zone of an NXT Sales country value; "unknown" when it is empty or not recognised (never guessed). */
export function zoneOf(country: string | null | undefined): Zone {
  if (!country) return 'unknown'
  const f = fold(country)
  if (!f) return 'unknown'
  const direct = LOOKUP.get(f)
  if (direct) return direct
  // "Mumbai, India" / "Dubai - UAE" / "India (Head office)": the last recognised piece decides
  const pieces = country.split(/[,;/|()\-]+/).map(fold).filter(Boolean).reverse()
  for (const p of pieces) {
    const z = LOOKUP.get(p)
    if (z && p.length > 2) return z
  }
  return 'unknown'
}
