import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { PassThrough } from 'node:stream'
import JSZip from 'jszip'
import archiver from 'archiver'
import { companyFileKey, COMPANY_FILE_MAX_BYTES, fileKey, matchCompanyFiles, MAX_ZIP_ENTRIES, NAME_RE, readCompanyZip } from '../../src/outreach/bulk/companyZip.js'
import { MAX_FILE_BYTES } from '../../src/outreach/bulk/attachments.js'
import { makeZip, pdf } from '../helpers/makeZip.js'

// ZIP OF COMPANY-WISE PDFs (2026-10-17): reading the ZIP safely and matching its
// files to the companies of the Excel — never guessing, never trusting the ZIP.

const byName = (scan: ReturnType<typeof readCompanyZip>) => Object.fromEntries(scan.files.map((f) => [f.fileName, f]))

describe('reading a ZIP of PDFs', () => {
  it('reads stored and compressed PDFs and returns their exact bytes', () => {
    const a = pdf('ABC')
    const b = pdf('XYZ'.repeat(500))
    const scan = readCompanyZip(makeZip([{ name: 'ABC Limited.pdf', data: a, method: 0 }, { name: 'XYZ Industries.pdf', data: b, method: 8 }]))
    expect(scan.files.map((f) => [f.fileName, f.status, f.sizeBytes])).toEqual([['ABC Limited.pdf', 'ok', a.length], ['XYZ Industries.pdf', 'ok', b.length]])
    expect(byName(scan)['ABC Limited.pdf']!.bytes!.equals(a)).toBe(true)
    expect(byName(scan)['XYZ Industries.pdf']!.bytes!.equals(b)).toBe(true)
    expect(byName(scan)['ABC Limited.pdf']!.sha256).toBe(createHash('sha256').update(a).digest('hex'))
    expect(scan.problems).toEqual([])
  })

  it('uses the file name inside folders, skips folders and system files, accepts Windows back-slashes', () => {
    const scan = readCompanyZip(
      makeZip([
        { name: 'PDFs/', folder: true },
        { name: 'PDFs/ABC Limited.pdf', data: pdf('1') },
        { name: '__MACOSX/PDFs/._ABC Limited.pdf', data: Buffer.from('mac') },
        { name: '.DS_Store', data: Buffer.from('x') },
        { name: 'Thumbs.db', data: Buffer.from('x') },
        { name: 'PDFs\\XYZ Industries.pdf', data: pdf('2') },
      ]),
    )
    expect(scan.files.map((f) => [f.path, f.fileName, f.status])).toEqual([['PDFs/ABC Limited.pdf', 'ABC Limited.pdf', 'ok'], ['PDFs/XYZ Industries.pdf', 'XYZ Industries.pdf', 'ok']])
    expect(scan.ignored).toBe(3) // the mac folder's file, .DS_Store and Thumbs.db (a plain folder is not counted)
  })

  it('files that are not PDFs are "unsupported" — programs included — and never used', () => {
    const scan = readCompanyZip(makeZip([{ name: 'notes.txt', data: Buffer.from('hi') }, { name: 'ABC Limited.docx', data: Buffer.from('x') }, { name: 'setup.exe', data: Buffer.from('MZ') }, { name: 'README', data: Buffer.from('x') }, { name: 'ok.pdf', data: pdf() }]))
    expect(scan.files.map((f) => [f.fileName, f.status])).toEqual([['notes.txt', 'unsupported'], ['ABC Limited.docx', 'unsupported'], ['setup.exe', 'unsupported'], ['README', 'unsupported'], ['ok.pdf', 'ok']])
    expect(scan.files.every((f) => f.status === 'ok' || f.bytes === null)).toBe(true)
  })

  it('a file is invalid (not sent) when it is empty, too large, encrypted, damaged, lying about its size, or not a real PDF', () => {
    const real = pdf('real')
    const scan = readCompanyZip(
      makeZip([
        { name: 'empty.pdf', data: Buffer.alloc(0), method: 0 },
        { name: 'huge.pdf', data: real, declaredSize: COMPANY_FILE_MAX_BYTES + 1 },
        { name: 'locked.pdf', data: real, flags: 1 },
        { name: 'weird-method.pdf', data: real, method: 12 },
        { name: 'bad-crc.pdf', data: real, crc: 12345 },
        { name: 'size-lie.pdf', data: real, declaredSize: 5 }, // claims 5 bytes, really more
        { name: 'cut-short.pdf', data: real, compressed: Buffer.from([0x01]) },
        { name: 'not-a-pdf.pdf', data: Buffer.from('just text, no pdf header') },
        { name: 'good.pdf', data: real },
      ]),
    )
    const f = byName(scan)
    expect(Object.entries(f).map(([n, x]) => [n, x.status])).toEqual([
      ['empty.pdf', 'invalid'], ['huge.pdf', 'invalid'], ['locked.pdf', 'invalid'], ['weird-method.pdf', 'invalid'], ['bad-crc.pdf', 'invalid'], ['size-lie.pdf', 'invalid'], ['cut-short.pdf', 'invalid'], ['not-a-pdf.pdf', 'invalid'], ['good.pdf', 'ok'],
    ])
    expect(f['empty.pdf']!.reason).toMatch(/empty/)
    expect(f['huge.pdf']!.reason).toMatch(/larger than 7 MB/)
    expect(f['locked.pdf']!.reason).toMatch(/password/)
    expect(f['bad-crc.pdf']!.reason).toMatch(/checksum/)
    expect(f['size-lie.pdf']!.reason).toMatch(/could not be unpacked/)
    expect(f['not-a-pdf.pdf']!.reason).toMatch(/not a valid PDF/)
    expect(scan.files.filter((x) => x.status !== 'ok').every((x) => x.bytes === null && x.sha256 === null)).toBe(true)
  })

  it('unsafe or unusable names are invalid: ../ paths, absolute paths, drive letters, quotes and colons', () => {
    const scan = readCompanyZip(makeZip([{ name: '../evil.pdf', data: pdf() }, { name: '/abs/evil.pdf', data: pdf() }, { name: 'C:/evil.pdf', data: pdf() }, { name: 'a"b.pdf', data: pdf() }, { name: 'a:b.pdf', data: pdf() }]))
    expect(scan.files.map((f) => f.status)).toEqual(['invalid', 'invalid', 'invalid', 'invalid', 'invalid'])
    expect(scan.files.every((f) => f.bytes === null)).toBe(true)
  })

  it('a zip bomb is stopped: a header that lies about the size cannot expand into memory, and a huge total is refused', () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0) // compresses to a few KB
    const bomb = makeZip([{ name: 'bomb.pdf', data: big, declaredSize: 1000 }])
    const scan = readCompanyZip(bomb)
    expect(scan.files[0]).toMatchObject({ status: 'invalid' })
    expect(scan.files[0]!.reason).toMatch(/could not be unpacked/)
    // Many files that each claim the maximum size: refused as a whole before anything large is built.
    const many = makeZip(Array.from({ length: 16 }, (_, i) => ({ name: `f${i}.pdf`, data: pdf(String(i)), declaredSize: COMPANY_FILE_MAX_BYTES })))
    expect(() => readCompanyZip(many)).toThrow(/larger than 100 MB when unpacked/)
  })

  it('refuses what is not a plain ZIP: text, truncated files, empty ZIPs, ZIP64 markers, multi-part, too many entries, a broken directory', () => {
    const good = makeZip([{ name: 'a.pdf', data: pdf() }])
    expect(() => readCompanyZip(Buffer.from('this is not a zip file at all, just text'))).toThrow(/not a ZIP/)
    expect(() => readCompanyZip(Buffer.alloc(0))).toThrow(/not a ZIP/)
    expect(() => readCompanyZip(good.subarray(0, good.length - 10))).toThrow(/not a ZIP/)
    expect(() => readCompanyZip(makeZip([]))).toThrow(/empty/)
    expect(() => readCompanyZip(makeZip([{ name: 'a.pdf', data: pdf() }], { total: 0xffff }))).toThrow(/ZIP64/)
    expect(() => readCompanyZip(makeZip([{ name: 'a.pdf', data: pdf() }], { disk: 1 }))).toThrow(/Multi-part/)
    expect(() => readCompanyZip(makeZip(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, i) => ({ name: `f${i}.pdf`, data: Buffer.from('x'), method: 0 }))))).toThrow(/more than 5000 entries/)
    const broken = Buffer.from(good)
    broken.writeUInt32LE(0xdeadbeef, broken.length - 22 + 16) // central directory offset points into nowhere
    expect(() => readCompanyZip(broken)).toThrow(/not a ZIP/)
  })

  it('a comment that contains a fake end-of-directory record does not fool the reader', () => {
    const fake = Buffer.alloc(22)
    fake.writeUInt32LE(0x06054b50, 0)
    fake.writeUInt16LE(7, 4) // would claim "disk 7"
    fake.writeUInt16LE(500, 20) // a comment length that does not reach the end
    const scan = readCompanyZip(makeZip([{ name: 'a.pdf', data: pdf('c') }], { comment: Buffer.concat([Buffer.from('note '), fake, Buffer.from(' end')]) }))
    expect(scan.files.map((f) => [f.fileName, f.status])).toEqual([['a.pdf', 'ok']])
  })

  it('names are read as UTF-8 (flagged or not) so accented company names match', () => {
    const scan = readCompanyZip(makeZip([{ name: 'Société Générale.pdf', data: pdf('1') }, { name: 'Müller GmbH.pdf', data: pdf('2'), noUtf8Flag: true }]))
    expect(scan.files.map((f) => [f.fileName, f.status])).toEqual([['Société Générale.pdf', 'ok'], ['Müller GmbH.pdf', 'ok']])
    expect(matchCompanyFiles(['Société Générale', 'Müller GmbH'], scan.files).map((m) => m.status)).toEqual(['matched', 'matched'])
  })

  it('reads ZIPs made by other tools: JSZip (compressed, folders, comment) and archiver (checksums after the data)', async () => {
    const a = pdf('made by jszip')
    const jz = new JSZip()
    jz.folder('Reports')!.file('ABC Limited.pdf', a)
    jz.file('XYZ Industries.pdf', pdf('x'.repeat(2000)))
    const jbuf = await jz.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', comment: 'made by someone' })
    const s1 = readCompanyZip(jbuf)
    expect(s1.files.map((f) => [f.fileName, f.status])).toEqual([['ABC Limited.pdf', 'ok'], ['XYZ Industries.pdf', 'ok']])
    expect(byName(s1)['ABC Limited.pdf']!.bytes!.equals(a)).toBe(true)

    const c = pdf('made by archiver')
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (d: Buffer) => chunks.push(d))
    const done = new Promise<void>((res, rej) => {
      out.on('end', () => res())
      out.on('error', rej)
    })
    const arc = archiver('zip', { zlib: { level: 9 } })
    arc.pipe(out)
    arc.append(Buffer.from(c), { name: 'ABC Limited.pdf' })
    arc.append(pdf('second'), { name: 'Test Corporation.pdf' })
    await arc.finalize()
    await done
    const s2 = readCompanyZip(Buffer.concat(chunks))
    expect(s2.files.map((f) => [f.fileName, f.status])).toEqual([['ABC Limited.pdf', 'ok'], ['Test Corporation.pdf', 'ok']])
    expect(byName(s2)['ABC Limited.pdf']!.bytes!.equals(c)).toBe(true)
  })

  it('shares its limits and name rule with ordinary attachments', () => {
    expect(COMPANY_FILE_MAX_BYTES).toBe(MAX_FILE_BYTES)
    for (const ok of ['ABC Limited.pdf', 'Smith & Sons (UK).pdf']) expect(NAME_RE.test(ok)).toBe(true)
    for (const bad of ['a/b.pdf', 'a"b.pdf', 'a:b.pdf', 'a\nb.pdf', '']) expect(NAME_RE.test(bad)).toBe(false)
  })
})

describe('company names and file names', () => {
  it('capital letters, extra spaces, punctuation and the .pdf extension do not matter', () => {
    const keys = ['ABC Limited', '  abc   LIMITED ', 'Abc_Limited', 'ABC Limited.'].map(companyFileKey)
    expect(new Set(keys)).toEqual(new Set(['abc limited']))
    expect(['ABC Limited.pdf', 'abc limited.PDF', 'ABC  Limited .pdf'].map(fileKey)).toEqual(['abc limited', 'abc limited', 'abc limited'])
    expect(companyFileKey('A/B Co')).toBe(fileKey('A-B Co.pdf'))
  })

  it('different names stay different: nothing is guessed', () => {
    expect(companyFileKey('ABC Limited')).not.toBe(companyFileKey('ABC Ltd'))
    expect(companyFileKey('Smith and Sons')).not.toBe(companyFileKey('Smith & Sons'))
    expect(companyFileKey('ABC')).not.toBe(companyFileKey('ABC Holdings'))
    expect(companyFileKey('...')).toBe('')
  })
})

describe('matching files to companies', () => {
  const zip = (names: string[]) => readCompanyZip(makeZip(names.map((n, i) => ({ name: n, data: pdf(String(i)) })))).files

  it('the example: each company gets exactly its own file', () => {
    const files = zip(['ABC Limited.pdf', 'XYZ Industries.pdf', 'Test Corporation.pdf'])
    const m = matchCompanyFiles(['ABC Limited', 'XYZ Industries', 'Test Corporation'], files)
    expect(m.map((x) => [x.status, x.file?.fileName])).toEqual([['matched', 'ABC Limited.pdf'], ['matched', 'XYZ Industries.pdf'], ['matched', 'Test Corporation.pdf']])
    expect(new Set(m.map((x) => x.file!.sha256)).size).toBe(3) // three different files
  })

  it('safe variations match: capitals, extra spaces, extension, folder', () => {
    const files = zip(['reports/abc  LIMITED.PDF', 'xyz_industries.pdf'])
    expect(matchCompanyFiles(['ABC Limited', 'XYZ Industries'], files).map((x) => x.status)).toEqual(['matched', 'matched'])
  })

  it('no file: missing, with a hint when the file is there but is not a PDF', () => {
    const files = readCompanyZip(makeZip([{ name: 'ABC Limited.pdf', data: pdf() }, { name: 'XYZ Industries.docx', data: Buffer.from('x') }])).files
    const m = matchCompanyFiles(['ABC Limited', 'XYZ Industries', 'Test Corporation'], files)
    expect(m.map((x) => x.status)).toEqual(['matched', 'missing', 'missing'])
    expect(m[1]!.detail).toMatch(/only PDF files are used/)
    expect(m[2]!.detail).toMatch(/No PDF in the ZIP is named after this company/)
    expect(m[2]!.file).toBeNull()
  })

  it('several files could match one company: ambiguous, none chosen, all listed', () => {
    const files = zip(['a/ABC Limited.pdf', 'b/ABC Limited.pdf', 'ABC limited.pdf'])
    const m = matchCompanyFiles(['ABC Limited'], files)
    expect(m[0]).toMatchObject({ status: 'ambiguous', file: null })
    expect(m[0]!.detail).toMatch(/a\/ABC Limited\.pdf.*b\/ABC Limited\.pdf.*ABC limited\.pdf/)
    const scan = readCompanyZip(makeZip([{ name: 'a/ABC Limited.pdf', data: pdf('1') }, { name: 'b/ABC Limited.pdf', data: pdf('2') }, { name: 'abc  limited.pdf', data: pdf('3') }]))
    expect(scan.problems.join(' ')).toMatch(/Duplicate file name "ABC Limited.pdf"/)
    expect(scan.problems.join(' ')).toMatch(/would both match the same company/)
  })

  it('one file matching two companies of the Excel is ambiguous for both', () => {
    const files = zip(['ABC Ltd.pdf', 'Other.pdf'])
    const m = matchCompanyFiles(['ABC Ltd', 'ABC Ltd.', 'Other'], files)
    expect(m.map((x) => x.status)).toEqual(['ambiguous', 'ambiguous', 'matched'])
    expect(m[0]!.detail).toMatch(/matches more than one company/)
  })

  it('a matching file that is invalid is reported as invalid, never swapped for another', () => {
    const files = readCompanyZip(makeZip([{ name: 'ABC Limited.pdf', data: Buffer.from('not a pdf') }, { name: 'XYZ Industries.pdf', data: pdf() }])).files
    const m = matchCompanyFiles(['ABC Limited', 'XYZ Industries'], files)
    expect(m.map((x) => x.status)).toEqual(['invalid', 'matched'])
    expect(m[0]!.detail).toMatch(/cannot be used: it is not a valid PDF/)
    expect(m[1]!.file!.fileName).toBe('XYZ Industries.pdf')
  })

  it('a company name with nothing to match by is missing', () => {
    expect(matchCompanyFiles(['---'], zip(['x.pdf']))[0]).toMatchObject({ status: 'missing' })
  })
})
