import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, readdir, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { env } from '../../config/env.js'
import { prisma, newId } from '../../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.js'
import { MAX_ZIP_BYTES, NAME_RE, readCompanyZip, scanOnce, withFileSource, type ZipFile, type ZipScan, type ZipSource } from './companyZip.js'

// ATTACHMENTS FOR BULK EMAIL (2026-10-12).
//
// Files are uploaded ONCE, below the email preview, and the same files go
// with every email of the send. An upload is "staged" (no send yet); when the
// send starts, its staged files are linked to it and kept with it, so every
// email carries exactly what was approved. Through NXT Sales the files travel
// with each email to its Gmail pipeline (the open-tracking pixel is in the
// HTML part and is not affected); through this platform's mailbox they become
// ordinary attachments.

export const MAX_ATTACHMENTS = 5
/** All files of one send together (decoded). */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
/** One file: base64 of 7 MB stays under the API's 10 MB request limit. */
export const MAX_FILE_BYTES = 7 * 1024 * 1024
const STAGED_KEEP_MS = 24 * 60 * 60 * 1000

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/
const BLOCKED = new Set([
  'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msp', 'dll', 'jar', 'js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'ps1', 'psm1',
  'reg', 'lnk', 'hta', 'cpl', 'app', 'apk', 'sh', 'bin', 'iso', 'dmg',
])
const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  rtf: 'application/rtf',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
}

export interface AttachmentInfo {
  id: string
  fileName: string
  mimeType: string
  sizeBytes: number
}

/** One file as it travels with an email: raw standard base64, no data: prefix. */
export interface AttachmentFile {
  filename: string
  mimeType: string
  content: string
}

interface Actor {
  tenantId: string
  crmUserId: string
}

const extOf = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '')

/** Validates one uploaded file. Pure; throws BadRequestError with a message a person can act on. */
export function checkFile(input: { fileName: string; contentBase64: string }) {
  const fileName = String(input.fileName ?? '').trim()
  if (!NAME_RE.test(fileName) || fileName === '.' || fileName === '..') {
    throw new BadRequestError('This file name cannot be used. Rename the file (letters, digits, spaces, - _ . ( ) are fine) and upload it again.')
  }
  const ext = extOf(fileName)
  if (BLOCKED.has(ext)) throw new BadRequestError(`.${ext} files cannot be attached (programs and scripts are blocked).`)
  const content = String(input.contentBase64 ?? '').replace(/^data:[^,]*,/, '')
  if (!content || content.length % 4 !== 0 || !BASE64_RE.test(content)) throw new BadRequestError('The file could not be read. Upload it again.')
  const bytes = Buffer.from(content, 'base64')
  if (bytes.length === 0) throw new BadRequestError('The file is empty.')
  if (bytes.length > MAX_FILE_BYTES) throw new BadRequestError(`"${fileName}" is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB.`)
  return { fileName, mimeType: MIME_BY_EXT[ext] ?? 'application/octet-stream', bytes, sha256: createHash('sha256').update(bytes).digest('hex') }
}

const info = (r: { id: string; fileName: string; mimeType: string; sizeBytes: number }): AttachmentInfo => ({
  id: r.id,
  fileName: r.fileName,
  mimeType: r.mimeType,
  sizeBytes: r.sizeBytes,
})

/** Stores one file for a send that has not started yet. Staged files older than a day are cleared first. */
export async function stageAttachment(actor: Actor, input: { fileName: string; contentBase64: string }, now = new Date()): Promise<AttachmentInfo> {
  const f = checkFile(input)
  await prisma.bulkAttachment.deleteMany({ where: { tenantId: actor.tenantId, campaignId: null, kind: { not: 'company_zip' }, createdAt: { lt: new Date(now.getTime() - STAGED_KEEP_MS) } } })
  const row = await prisma.bulkAttachment.create({
    data: {
      id: newId(),
      tenantId: actor.tenantId,
      campaignId: null,
      position: 0,
      fileName: f.fileName,
      mimeType: f.mimeType,
      sizeBytes: f.bytes.length,
      sha256: f.sha256,
      kind: 'common',
      content: f.bytes,
      createdByCrmUserId: actor.crmUserId,
    },
  })
  return info(row)
}

/** Removes a staged file (a file already linked to a send stays with it). A staged ZIP's file on disk goes with it. */
export async function removeStagedAttachment(actor: Actor, id: string): Promise<{ id: string; removed: true }> {
  const row = await prisma.bulkAttachment.findFirst({ where: { id, tenantId: actor.tenantId, campaignId: null }, select: { id: true, kind: true } })
  if (!row) throw new NotFoundError('Attachment not found.')
  if (row.kind === 'company_zip') {
    // After any piece or check that is running on this upload, so a piece can never recreate the file that was just removed.
    return locked(id, async () => {
      await prisma.bulkAttachment.deleteMany({ where: { id, tenantId: actor.tenantId, campaignId: null } })
      await rmFile(zipPath(id))
      return { id, removed: true as const }
    })
  }
  await prisma.bulkAttachment.deleteMany({ where: { id, tenantId: actor.tenantId, campaignId: null } })
  return { id, removed: true }
}

/** The staged files a review or start names, in the order given — checked against every limit. */
export async function stagedAttachments(actor: Actor, ids: string[] | undefined): Promise<AttachmentInfo[]> {
  const list = ids ?? []
  if (!list.length) return []
  if (new Set(list).size !== list.length) throw new BadRequestError('The same attachment is listed twice.')
  if (list.length > MAX_ATTACHMENTS) throw new BadRequestError(`At most ${MAX_ATTACHMENTS} attachments.`)
  const rows = await prisma.bulkAttachment.findMany({
    where: { id: { in: list }, tenantId: actor.tenantId, campaignId: null, kind: 'common' },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
  })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const out = list.map((id) => byId.get(id))
  if (out.some((r) => !r)) throw new BadRequestError('An attachment is no longer available. Remove it and upload it again.')
  const total = out.reduce((s, r) => s + r!.sizeBytes, 0)
  if (total > MAX_ATTACHMENT_BYTES) throw new BadRequestError(`The attachments are larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB in all.`)
  return out.map((r) => info(r!))
}

/** Links staged files to a send that has just been created; every one must still be staged. */
export async function linkAttachments(actor: Actor, ids: string[], campaignId: string): Promise<void> {
  for (const [position, id] of ids.entries()) {
    const r = await prisma.bulkAttachment.updateMany({ where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'common' }, data: { campaignId, position } })
    if (r.count !== 1) throw new ConflictError('An attachment is no longer available. Nothing was sent; upload it again and start again.')
  }
}

/** The files of a send, in order, as they travel with each email. */
export async function campaignAttachments(campaignId: string): Promise<AttachmentFile[]> {
  const rows = await prisma.bulkAttachment.findMany({ where: { campaignId, kind: 'common' }, orderBy: { position: 'asc' } })
  return rows.map((r) => ({ filename: r.fileName, mimeType: r.mimeType, content: Buffer.from(r.content).toString('base64') }))
}

/** For the screens: name and size of each file of a send. */
export async function campaignAttachmentInfo(campaignId: string): Promise<AttachmentInfo[]> {
  const rows = await prisma.bulkAttachment.findMany({
    where: { campaignId, kind: 'common' },
    orderBy: { position: 'asc' },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
  })
  return rows.map(info)
}

// ── ZIP of company-wise PDFs (2026-10-17; up to 1 GB since 2026-10-18) ──────
//
// A ZIP of up to 1 GB is uploaded in pieces of ZIP_CHUNK_BYTES (so no request is large, and a dropped connection
// loses one piece, not the whole file) and kept as a FILE on disk, never in the database or in memory. Its row
// (kind 'company_zip', no content) holds its name, its size and — once the upload is complete and checked — the
// SHA-256 of the whole file; a row with no hash is an upload still in progress. The review reads the ZIP's
// directory and PDFs through companyZip.ts (remembered by that hash). When the send starts, each matched company's
// PDF is read from the ZIP again (checked against the review's hash), stored as its own row (kind 'company_file')
// kept with the send and named by that recipient, and the ZIP file is removed. At sending time the recipient's own
// file is loaded, checked against its stored hash and against the recipient's company, and attached next to the
// send's common files.

/** One piece of an upload. Under the web server's 25 MB request limit. */
export const ZIP_CHUNK_BYTES = 16 * 1024 * 1024
/** Staged ZIPs of one tenant together (a ZIP being replaced is removed by the screen). */
const MAX_STAGED_ZIP_TOTAL_BYTES = 2 * MAX_ZIP_BYTES
/** Free disk space that must remain after a ZIP is stored. */
const DISK_MARGIN_BYTES = 5 * 1024 * 1024 * 1024
/** A ZIP file nobody started a send with. */
const ORPHAN_ZIP_KEEP_MS = 36 * 60 * 60 * 1000
/** An upload that has received no piece for this long is abandoned (the tab was closed, the connection was lost for good). */
const UPLOAD_IDLE_MS = 60 * 60 * 1000

export interface StagedZip {
  id: string
  fileName: string
  sizeBytes: number
}

/** The folder the ZIPs are kept in. */
const zipDir = () => env.BULK_ZIP_DIR || path.resolve(process.cwd(), 'storage', 'bulk-zips')

/** The file of one staged ZIP. The id is checked, so it can never point outside the folder. */
function zipPath(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new BadRequestError('The company ZIP is no longer available. Upload it again.')
  return path.join(zipDir(), `${id}.zip`)
}

const rmFile = (p: string) => rm(p, { force: true }).catch(() => undefined)

/** Pieces of one upload arrive one at a time; this keeps two requests for the same upload from interleaving. */
const UPLOAD_LOCKS = new Map<string, Promise<unknown>>()
function locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (UPLOAD_LOCKS.get(id) ?? Promise.resolve()).then(fn)
  // What is kept for the next request in line never fails: a request that was refused (the normal "continue from here" answer,
  // a bad ZIP) must not become an unhandled rejection, which would stop the whole server. The caller still gets the real result.
  const tail: Promise<void> = run
    .then(
      () => undefined,
      () => undefined,
    )
    .then(() => {
      if (UPLOAD_LOCKS.get(id) === tail) UPLOAD_LOCKS.delete(id)
    })
  UPLOAD_LOCKS.set(id, tail)
  return run
}

/**
 * Removes what nobody will use: ZIPs staged for more than a day, uploads that have received nothing for an hour (a closed tab
 * must not keep the space of a gigabyte), and old files of ours that no row points at. It only ever touches files named like
 * this app's own (<id>.zip) in the ZIP folder, so that folder should be one nothing else uses. Best effort.
 */
async function sweepStaleZips(now: Date): Promise<void> {
  try {
    const rows = await prisma.bulkAttachment.findMany({ where: { campaignId: null, kind: 'company_zip' }, select: { id: true, sha256: true, createdAt: true } })
    const live = new Set<string>()
    const gone: string[] = []
    for (const r of rows) {
      const file = zipPath(r.id)
      const st = await stat(file).catch(() => null)
      const old = now.getTime() - (r.createdAt?.getTime() ?? now.getTime()) > STAGED_KEEP_MS
      const abandoned = r.sha256 === '' && (!st || now.getTime() - st.mtimeMs > UPLOAD_IDLE_MS)
      if (old || abandoned) {
        gone.push(r.id)
        await rmFile(file)
      } else {
        live.add(r.id)
      }
    }
    if (gone.length) await prisma.bulkAttachment.deleteMany({ where: { id: { in: gone }, campaignId: null, kind: 'company_zip' } })
    for (const name of await readdir(zipDir()).catch(() => [] as string[])) {
      const mine = /^([A-Za-z0-9_-]{1,64})\.zip$/.exec(name)
      if (!mine || live.has(mine[1]!)) continue
      const file = path.join(zipDir(), name)
      const st = await stat(file).catch(() => null)
      if (st && now.getTime() - st.mtimeMs > ORPHAN_ZIP_KEEP_MS) await rmFile(file)
    }
  } catch {
    // Clearing old files must never stop a new upload.
  }
}

/** Starts an upload: checks the name, the size and the free disk space, and makes the (empty) file and its row. */
export async function startCompanyZipUpload(actor: Actor, input: { fileName: string; sizeBytes: number }, now = new Date()): Promise<StagedZip & { chunkBytes: number }> {
  const fileName = String(input.fileName ?? '').trim()
  if (!NAME_RE.test(fileName) || !/\.zip$/i.test(fileName)) throw new BadRequestError('Upload a file whose name ends in .zip (letters, digits, spaces, - _ . ( ) are fine).')
  const sizeBytes = Number(input.sizeBytes)
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new BadRequestError('The ZIP is empty.')
  if (sizeBytes > MAX_ZIP_BYTES) throw new BadRequestError(`The ZIP is larger than ${MAX_ZIP_BYTES / 1024 / 1024 / 1024} GB. Split the PDFs into two ZIPs and send them in two campaigns.`)
  await sweepStaleZips(now)
  const staged = await prisma.bulkAttachment.findMany({ where: { tenantId: actor.tenantId, campaignId: null, kind: 'company_zip' }, select: { sizeBytes: true } })
  if (staged.reduce((n, r) => n + r.sizeBytes, 0) + sizeBytes > MAX_STAGED_ZIP_TOTAL_BYTES) {
    throw new ConflictError('Too many ZIP files are waiting to be used. Remove the earlier ZIP (or start its send) and try again.')
  }
  await mkdir(zipDir(), { recursive: true, mode: 0o700 })
  const free = await statfs(zipDir()).then((s) => Number(s.bavail) * Number(s.bsize)).catch(() => Number.POSITIVE_INFINITY)
  if (free < sizeBytes + DISK_MARGIN_BYTES) throw new ConflictError('The server does not have enough free disk space for this ZIP. Ask an administrator.')

  const id = newId()
  await writeFile(zipPath(id), Buffer.alloc(0), { flag: 'wx', mode: 0o600 })
  try {
    await prisma.bulkAttachment.create({
      data: {
        id,
        tenantId: actor.tenantId,
        campaignId: null,
        position: 0,
        fileName,
        mimeType: 'application/zip',
        sizeBytes,
        sha256: '', // still uploading
        kind: 'company_zip',
        content: Buffer.alloc(0),
        createdByCrmUserId: actor.crmUserId,
      },
    })
  } catch (err) {
    await rmFile(zipPath(id))
    throw err
  }
  return { id, fileName, sizeBytes, chunkBytes: ZIP_CHUNK_BYTES }
}

/** An upload that is still in progress. */
async function pendingZip(actor: Actor, id: string) {
  const row = await prisma.bulkAttachment.findFirst({ where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'company_zip' }, select: { id: true, fileName: true, sizeBytes: true, sha256: true } })
  if (!row) throw new NotFoundError('Upload not found. Choose the ZIP again.')
  return row
}

/**
 * Adds the next piece. `offset` must be exactly where the file ends: a piece that was already received (a retry after a lost
 * answer) or one that skips ahead is answered with a 409 carrying how many bytes the server really has, so the screen carries on from there.
 */
export function appendZipChunk(actor: Actor, id: string, offset: number, bytes: Buffer): Promise<{ receivedBytes: number }> {
  return locked(id, async () => {
    const row = await pendingZip(actor, id)
    if (row.sha256 !== '') throw new ConflictError('This ZIP is already complete.', { receivedBytes: row.sizeBytes })
    if (!Number.isInteger(offset) || offset < 0) throw new BadRequestError('The position of this piece is missing.')
    if (!bytes.length) throw new BadRequestError('This piece is empty.')
    const have = (await stat(zipPath(id)).catch(() => null))?.size
    if (have === undefined) throw new NotFoundError('Upload not found. Choose the ZIP again.')
    if (offset !== have) throw new ConflictError(`The server has ${have} bytes of this ZIP; continue from there.`, { receivedBytes: have })
    if (have + bytes.length > row.sizeBytes) throw new BadRequestError('More data arrived than the size of the ZIP.')
    const handle = await open(zipPath(id), 'r+').catch(() => null)
    if (!handle) throw new NotFoundError('Upload not found. Choose the ZIP again.')
    try {
      let written = 0
      while (written < bytes.length) written += (await handle.write(bytes, written, bytes.length - written, have + written)).bytesWritten
    } finally {
      await handle.close()
    }
    return { receivedBytes: have + bytes.length }
  })
}

/** SHA-256 of a whole file, read in pieces. */
async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256')
  for await (const part of createReadStream(file)) h.update(part as Buffer)
  return h.digest('hex')
}

/** Scans a staged ZIP's file (remembered by its hash): names, sizes and hashes of its PDFs, never their content. */
export function scanStagedZip(zip: StagedZip & { sha256: string }): Promise<ZipScan> {
  return scanOnce(zip.sha256, () => withFileSource(zipPath(zip.id), readCompanyZip))
}

/**
 * Completes an upload: the file must be all there; it is hashed, read as a ZIP, and refused (and removed) if it has no usable PDF.
 * Safe to repeat: an upload already completed answers again with the same result.
 */
export function finishCompanyZipUpload(actor: Actor, id: string): Promise<StagedZip> {
  return locked(id, async () => {
    const row = await pendingZip(actor, id)
    if (row.sha256 !== '') return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes }
    const have = (await stat(zipPath(id)).catch(() => null))?.size
    if (have === undefined) throw new NotFoundError('Upload not found. Choose the ZIP again.')
    if (have !== row.sizeBytes) throw new ConflictError(`Only ${have} of ${row.sizeBytes} bytes arrived. Continue the upload.`, { receivedBytes: have })
    let sha256: string
    try {
      sha256 = await hashFile(zipPath(id))
      const scan: ZipScan = await scanOnce(sha256, () => withFileSource(zipPath(id), readCompanyZip))
      if (!scan.files.some((f) => f.status === 'ok')) {
        const why = scan.files.slice(0, 3).map((f) => `${f.fileName}: ${f.reason}`).join('; ')
        throw new BadRequestError(`The ZIP has no usable PDF files${why ? ` (${why})` : ''}. It should hold one PDF per company, named after the company.`)
      }
    } catch (err) {
      // Only a ZIP that is itself unusable is thrown away; a hiccup of the server (disk, database) keeps the upload so finishing can be repeated.
      if (err instanceof BadRequestError) {
        await rmFile(zipPath(id))
        await prisma.bulkAttachment.deleteMany({ where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'company_zip' } })
      } else if ((err as { code?: string })?.code === 'ENOENT') {
        throw new NotFoundError('Upload not found. Choose the ZIP again.')
      }
      throw err
    }
    await prisma.bulkAttachment.updateMany({ where: { id, tenantId: actor.tenantId, kind: 'company_zip', campaignId: null }, data: { sha256 } })
    return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes }
  })
}

/** Stages a ZIP that is already complete in memory (the same steps as an upload in pieces). */
export async function stageCompanyZip(actor: Actor, input: { fileName: string; bytes: Buffer }, now = new Date()): Promise<StagedZip> {
  const { id, chunkBytes } = await startCompanyZipUpload(actor, { fileName: input.fileName, sizeBytes: input.bytes.length }, now)
  try {
    for (let offset = 0; offset < input.bytes.length; offset += chunkBytes) await appendZipChunk(actor, id, offset, input.bytes.subarray(offset, offset + chunkBytes))
    return await finishCompanyZipUpload(actor, id)
  } catch (err) {
    await removeStagedAttachment(actor, id).catch(() => undefined)
    throw err
  }
}

/** A completed, staged ZIP: its name, size and the hash of its content. */
export async function stagedCompanyZipInfo(actor: Actor, id: string): Promise<StagedZip & { sha256: string }> {
  const row = await prisma.bulkAttachment.findFirst({
    where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'company_zip', sha256: { not: '' } },
    select: { id: true, fileName: true, sizeBytes: true, sha256: true },
  })
  if (!row) throw new BadRequestError('The company ZIP is no longer available. Upload it again.')
  return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes, sha256: row.sha256 }
}

/** Opens a staged ZIP's file for reading while `fn` runs. */
export function withStagedZip<T>(id: string, fn: (src: ZipSource) => Promise<T>): Promise<T> {
  return withFileSource(zipPath(id), fn)
}

/** Drops a staged ZIP once its send has started (best effort: an old staged file is cleared anyway). */
export async function dropStagedZip(actor: Actor, id: string): Promise<void> {
  await prisma.bulkAttachment.deleteMany({ where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'company_zip' } })
  await rmFile(zipPath(id))
}

/** Keeps one company's PDF; returns its id for the recipient. Stored first with no send (campaignId null), tied to its send in one step by linkCompanyFiles. */
export async function storeCompanyFile(actor: Actor, campaignId: string | null, f: ZipFile, bytes: Buffer): Promise<string> {
  if (f.status !== 'ok' || !f.sha256 || createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new BadRequestError(`"${f.fileName}" cannot be used.`)
  const row = await prisma.bulkAttachment.create({
    data: {
      id: newId(),
      tenantId: actor.tenantId,
      campaignId,
      position: 0,
      fileName: f.fileName,
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      sha256: f.sha256,
      kind: 'company_file',
      content: bytes,
      createdByCrmUserId: actor.crmUserId,
    },
  })
  return row.id
}

/** Ties the stored company PDFs to the send that has just been created; every one must still be there. */
export async function linkCompanyFiles(actor: Actor, ids: string[], campaignId: string): Promise<void> {
  if (!ids.length) return
  const r = await prisma.bulkAttachment.updateMany({ where: { id: { in: ids }, tenantId: actor.tenantId, campaignId: null, kind: 'company_file' }, data: { campaignId } })
  if (r.count !== ids.length) throw new ConflictError('A company PDF is no longer available. Nothing was sent; upload the ZIP again and start again.')
}

/** Removes company PDFs that were stored for a send that did not start. */
export async function discardCompanyFiles(ids: string[]): Promise<void> {
  if (!ids.length) return
  await prisma.bulkAttachment.deleteMany({ where: { id: { in: ids }, campaignId: null, kind: 'company_file' } })
}

/** A recipient's own company PDF as it travels with the email; null when it is missing or its content no longer matches its stored hash. */
export async function companyFileForSend(campaignId: string, id: string): Promise<(AttachmentFile & { sizeBytes: number }) | null> {
  const row = await prisma.bulkAttachment.findFirst({ where: { id, campaignId, kind: 'company_file' } })
  if (!row) return null
  const bytes = Buffer.from(row.content)
  if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) return null
  return { filename: row.fileName, mimeType: row.mimeType, content: bytes.toString('base64'), sizeBytes: row.sizeBytes }
}

/** For the screens: the company PDFs of a send, by id. */
export async function companyFileInfos(campaignId: string): Promise<Map<string, AttachmentInfo>> {
  const rows = await prisma.bulkAttachment.findMany({
    where: { campaignId, kind: 'company_file' },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
  })
  return new Map(rows.map((r) => [r.id, info(r)]))
}
