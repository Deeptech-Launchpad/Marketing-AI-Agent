import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'
import { BadRequestError } from '../../platform/errors.js'

// ZIP OF COMPANY-WISE PDFs (2026-10-17).
//
// The user uploads ONE ZIP holding one PDF per company, each file named after
// its company ("ABC Limited.pdf"). Each recipient's email gets only the PDF
// whose name matches that recipient's company. This file reads the ZIP and
// matches files to companies; it touches no database and sends nothing.
//
// The ZIP is untrusted input, so it is read with hard limits and never written
// to disk: a ZIP is refused whole when it is not a plain ZIP, is encrypted,
// needs ZIP64, has too many entries, or would expand past a size cap; a single
// file is marked invalid when it is empty, too large, damaged (its size or
// CRC-32 does not match), not a real PDF, or has an unsafe name. Only PDFs are
// used. Nothing is guessed: a company with no matching file, or with several,
// is reported and must be fixed or excluded before anything is sent.

/** The ZIP itself (uploaded as raw bytes). Under the 25 MB the web server accepts. */
export const MAX_ZIP_BYTES = 20 * 1024 * 1024
/** Entries in the ZIP's directory (files, folders and junk together). */
export const MAX_ZIP_ENTRIES = 5000
/** All PDFs of one ZIP together, unpacked — stops a small ZIP expanding into a huge one. */
export const MAX_ZIP_UNPACKED_BYTES = 100 * 1024 * 1024
/** One company's PDF. Same as the limit for any attachment. */
export const COMPANY_FILE_MAX_BYTES = 7 * 1024 * 1024

// No control characters, quotes, slashes or other header/path-significant characters.
// eslint-disable-next-line no-control-regex
export const NAME_RE = /^[^\x00-\x1f\x7f"\\/<>:*?|]{1,150}$/

const NOT_A_ZIP = 'This is not a ZIP file (or it is damaged). Make the ZIP again and upload it.'
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

export type ZipFileStatus = 'ok' | 'invalid' | 'unsupported'

export interface ZipFile {
  /** As stored in the ZIP, folders included (forward slashes). */
  path: string
  /** The file's own name: what is attached to the email. */
  fileName: string
  /** The normalised name used to match a company. */
  key: string
  sizeBytes: number
  status: ZipFileStatus
  /** Why it cannot be used (null for a usable PDF). */
  reason: string | null
  sha256: string | null
  /** The file's content, for a usable PDF only. */
  bytes: Buffer | null
}

export interface ZipScan {
  files: ZipFile[]
  /** System files (for example __MACOSX, .DS_Store, Thumbs.db) skipped without comment; folders are not counted. */
  ignored: number
  /** Problems that concern the ZIP as a whole: duplicate or colliding names. */
  problems: string[]
}

/**
 * The name a company is matched by: letters and digits only, lower case, single
 * spaces (letters keep their accents and marks). So "ABC Ltd.", "abc  ltd" and "ABC_Ltd" are the same name — and
 * "ABC Limited" is not "ABC Ltd" (nothing is guessed).
 */
export function companyFileKey(name: string): string {
  return String(name ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
}

/** A file's matching name: its own name without the .pdf extension. */
export const fileKey = (fileName: string) => companyFileKey(fileName.replace(/\.pdf$/i, ''))

// ── The ZIP container ──────────────────────────────────────────────────────

interface DirEntry {
  name: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  offset: number
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(b: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function decodeName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return raw.toString('utf8')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    return raw.toString('latin1')
  }
}

/** The directory of a ZIP: every entry's name, sizes, CRC and position. Throws BadRequestError when it is not a plain, readable ZIP. */
function readDirectory(buf: Buffer): DirEntry[] {
  if (buf.length < 22) throw new BadRequestError(NOT_A_ZIP)
  // The end-of-directory record: the LAST one whose comment length reaches exactly the end of the file.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new BadRequestError(NOT_A_ZIP)
  const disk = buf.readUInt16LE(eocd + 4)
  const dirDisk = buf.readUInt16LE(eocd + 6)
  const onDisk = buf.readUInt16LE(eocd + 8)
  const total = buf.readUInt16LE(eocd + 10)
  const dirSize = buf.readUInt32LE(eocd + 12)
  const dirOffset = buf.readUInt32LE(eocd + 16)
  if (disk !== 0 || dirDisk !== 0 || onDisk !== total) throw new BadRequestError('Multi-part ZIP files are not supported. Make a single ZIP file.')
  if (total === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    throw new BadRequestError('ZIP64 archives are not supported. Make a normal ZIP file (it should stay under 20 MB).')
  }
  if (total === 0) throw new BadRequestError('The ZIP is empty.')
  if (total > MAX_ZIP_ENTRIES) throw new BadRequestError(`The ZIP has more than ${MAX_ZIP_ENTRIES} entries.`)
  const dirEnd = dirOffset + dirSize
  if (dirEnd > eocd) throw new BadRequestError(NOT_A_ZIP)

  const out: DirEntry[] = []
  let p = dirOffset
  for (let i = 0; i < total; i++) {
    if (p + 46 > dirEnd || buf.readUInt32LE(p) !== 0x02014b50) throw new BadRequestError(NOT_A_ZIP)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) {
      throw new BadRequestError('ZIP64 archives are not supported. Make a normal ZIP file (it should stay under 20 MB).')
    }
    const next = p + 46 + nameLen + extraLen + commentLen
    if (next > dirEnd) throw new BadRequestError(NOT_A_ZIP)
    out.push({ name: decodeName(buf.subarray(p + 46, p + 46 + nameLen), flags), flags, method, crc, compressedSize, size, offset })
    p = next
  }
  return out
}

/** One entry's content, checked against its declared size and CRC-32. Throws Error with a short reason. */
function unpack(buf: Buffer, e: DirEntry): Buffer {
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error('its position in the ZIP is damaged')
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28)
  const end = start + e.compressedSize
  if (end > buf.length) throw new Error('the ZIP is cut short')
  const data = buf.subarray(start, end)
  let out: Buffer
  if (e.method === 0) {
    if (e.compressedSize !== e.size) throw new Error('its size is inconsistent')
    out = Buffer.from(data)
  } else {
    // Never inflates beyond the declared size, so a lying header cannot expand into memory.
    out = inflateRawSync(data, { maxOutputLength: e.size })
  }
  if (out.length !== e.size) throw new Error('its size does not match')
  if (crc32(out) !== e.crc) throw new Error('its content is damaged (checksum mismatch)')
  return out
}

// ── Reading and checking the files ─────────────────────────────────────────

const isUnsafePath = (path: string) => path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').includes('..')

/** Reads the ZIP and checks every file in it. Throws BadRequestError when the ZIP as a whole cannot be used. */
export function readCompanyZip(buf: Buffer): ZipScan {
  const entries = readDirectory(buf)
  const files: ZipFile[] = []
  let ignored = 0
  let unpacked = 0

  for (const e of entries) {
    const path = e.name.replace(/\\/g, '/')
    if (path.endsWith('/')) continue // a folder
    const segments = path.split('/')
    const fileName = segments[segments.length - 1] ?? ''
    if (segments.includes('__MACOSX') || fileName.startsWith('._') || JUNK_NAMES.has(fileName.toLowerCase())) {
      ignored++
      continue
    }
    const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
    // A PDF is matched by its name without .pdf; any other file by its name without its own extension (to hint "found a .docx").
    const key = ext === 'pdf' ? fileKey(fileName) : companyFileKey(fileName.replace(/\.[^./]*$/, ''))
    const file: ZipFile = { path, fileName, key, sizeBytes: e.size, status: 'invalid', reason: null, sha256: null, bytes: null }
    const reject = (status: ZipFileStatus, reason: string) => {
      files.push({ ...file, status, reason })
    }

    if (isUnsafePath(path)) {
      reject('invalid', 'its path in the ZIP is not allowed')
      continue
    }
    if (!NAME_RE.test(fileName)) {
      reject('invalid', 'its file name cannot be used (rename it: letters, digits, spaces, - _ . ( ) are fine)')
      continue
    }
    if (ext !== 'pdf') {
      reject('unsupported', ext ? `only PDF files are used (this is .${ext})` : 'only PDF files are used')
      continue
    }
    if (e.flags & 1) {
      reject('invalid', 'it is password-protected inside the ZIP')
      continue
    }
    if (e.method !== 0 && e.method !== 8) {
      reject('invalid', 'it uses a ZIP compression this tool cannot read')
      continue
    }
    if (e.size === 0) {
      reject('invalid', 'the file is empty')
      continue
    }
    if (e.size > COMPANY_FILE_MAX_BYTES) {
      reject('invalid', `it is larger than ${COMPANY_FILE_MAX_BYTES / 1024 / 1024} MB`)
      continue
    }
    unpacked += e.size
    if (unpacked > MAX_ZIP_UNPACKED_BYTES) {
      throw new BadRequestError(`The files in this ZIP are larger than ${MAX_ZIP_UNPACKED_BYTES / 1024 / 1024} MB when unpacked. Split them into smaller ZIPs.`)
    }
    let bytes: Buffer
    try {
      bytes = unpack(buf, e)
    } catch (err) {
      reject('invalid', `it could not be unpacked — ${String((err as Error).message ?? err).slice(0, 120)}`)
      continue
    }
    if (!bytes.subarray(0, 1024).includes('%PDF-')) {
      reject('invalid', 'it is not a valid PDF file')
      continue
    }
    files.push({ ...file, status: 'ok', reason: null, sha256: createHash('sha256').update(bytes).digest('hex'), bytes })
  }

  return { files, ignored, problems: nameProblems(files) }
}

/** Duplicate file names, and different names that would match the same company. */
function nameProblems(files: ZipFile[]): string[] {
  const out: string[] = []
  const pdfs = files.filter((f) => f.status !== 'unsupported' && f.key)
  const byName = new Map<string, ZipFile[]>()
  for (const f of pdfs) byName.set(f.fileName.toLowerCase(), [...(byName.get(f.fileName.toLowerCase()) ?? []), f])
  for (const group of byName.values()) {
    if (group.length > 1) out.push(`Duplicate file name "${group[0]!.fileName}" (${group.map((f) => f.path).join(' and ')}). Keep one.`)
  }
  const byKey = new Map<string, ZipFile[]>()
  for (const f of pdfs) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f])
  for (const group of byKey.values()) {
    const names = new Set(group.map((f) => f.fileName.toLowerCase()))
    if (names.size > 1) out.push(`${[...new Set(group.map((f) => `"${f.fileName}"`))].join(' and ')} would both match the same company. Keep one.`)
  }
  return out
}

// ── A remembered scan ──────────────────────────────────────────────────────
//
// Unpacking and checking a ZIP of up to 20 MB takes a moment, and the screen reviews again on every change.
// A scan is remembered by the hash of the ZIP's bytes (without the PDF contents — they are read again, from the
// stored ZIP, only when a send starts), so a review of an unchanged ZIP does not unpack it again.

const SCAN_CACHE = new Map<string, ZipScan>()
const SCAN_CACHE_MAX = 8

export function rememberScan(sha256: string, scan: ZipScan): void {
  SCAN_CACHE.delete(sha256)
  SCAN_CACHE.set(sha256, { ...scan, files: scan.files.map((f) => ({ ...f, bytes: null })) })
  while (SCAN_CACHE.size > SCAN_CACHE_MAX) SCAN_CACHE.delete(SCAN_CACHE.keys().next().value as string)
}

export function recallScan(sha256: string): ZipScan | undefined {
  const scan = SCAN_CACHE.get(sha256)
  if (scan) {
    SCAN_CACHE.delete(sha256)
    SCAN_CACHE.set(sha256, scan)
  }
  return scan
}

/** For tests. */
export function forgetScans(): void {
  SCAN_CACHE.clear()
}

// ── Matching files to companies ────────────────────────────────────────────

export type MatchStatus = 'matched' | 'missing' | 'ambiguous' | 'invalid'

export interface CompanyMatch {
  status: MatchStatus
  /** The one file that matches (for 'matched' and 'invalid'); null otherwise. */
  file: ZipFile | null
  /** In words: why it is not matched. */
  detail: string | null
}

/**
 * For each company name, the PDF that belongs to it. A company matches only
 * when exactly one file carries its name; no file → "missing", several →
 * "ambiguous", and a file that matches more than one company of the Excel is
 * ambiguous for all of them. Never picks one of several.
 */
export function matchCompanyFiles(companyNames: string[], files: ZipFile[], eligible?: boolean[]): CompanyMatch[] {
  const pdfs = new Map<string, ZipFile[]>()
  const unsupported = new Map<string, ZipFile[]>()
  for (const f of files) {
    if (!f.key) continue
    const target = f.status === 'unsupported' ? unsupported : pdfs
    target.set(f.key, [...(target.get(f.key) ?? []), f])
  }
  const keys = companyNames.map(companyFileKey)
  // A file that matches several companies is ambiguous for them all — but only companies that can actually be emailed count
  // (one skipped for another reason, such as its Status, does not need a file).
  const companiesPerKey = new Map<string, number[]>()
  keys.forEach((k, i) => {
    if (eligible?.[i] !== false) companiesPerKey.set(k, [...(companiesPerKey.get(k) ?? []), i])
  })

  return keys.map((key, i): CompanyMatch => {
    if (!key) return { status: 'missing', file: null, detail: 'The company name has no letters or digits to match a file by.' }
    const found = pdfs.get(key) ?? []
    if (found.length === 0) {
      const other = unsupported.get(key)?.[0]
      return { status: 'missing', file: null, detail: other ? `Found "${other.fileName}", but only PDF files are used.` : 'No PDF in the ZIP is named after this company.' }
    }
    if (found.length > 1) {
      return { status: 'ambiguous', file: null, detail: `Several files match: ${found.map((f) => `"${f.path}"`).join(', ')}. Keep only one.` }
    }
    const same = companiesPerKey.get(key) ?? []
    if (same.length > 1) {
      const others = same.filter((j) => j !== i).map((j) => `"${companyNames[j]}"`)
      return { status: 'ambiguous', file: null, detail: `"${found[0]!.fileName}" matches more than one company in your Excel (also ${others.join(', ')}).` }
    }
    const f = found[0]!
    return f.status === 'ok' ? { status: 'matched', file: f, detail: null } : { status: 'invalid', file: f, detail: `"${f.fileName}" cannot be used: ${f.reason}.` }
  })
}
