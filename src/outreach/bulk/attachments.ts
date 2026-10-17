import { createHash } from 'node:crypto'
import { prisma, newId } from '../../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.js'
import { MAX_ZIP_BYTES, NAME_RE, readCompanyZip, rememberScan, type ZipFile } from './companyZip.js'

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
  await prisma.bulkAttachment.deleteMany({ where: { tenantId: actor.tenantId, campaignId: null, createdAt: { lt: new Date(now.getTime() - STAGED_KEEP_MS) } } })
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

/** Removes a staged file (a file already linked to a send stays with it). */
export async function removeStagedAttachment(actor: Actor, id: string): Promise<{ id: string; removed: true }> {
  const row = await prisma.bulkAttachment.findFirst({ where: { id, tenantId: actor.tenantId, campaignId: null }, select: { id: true } })
  if (!row) throw new NotFoundError('Attachment not found.')
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

// ── ZIP of company-wise PDFs (2026-10-17) ──────────────────────────────────
//
// The ZIP is staged as ONE row (kind 'company_zip', never an attachment itself).
// The review reads it again every time, so what is shown is what is in the ZIP.
// When the send starts, each matched company's PDF is stored as its own row
// (kind 'company_file') kept with the send and named by that recipient, and the
// staged ZIP is dropped. At sending time the recipient's own file is loaded,
// checked against its stored hash and against the recipient's company, and
// attached next to the send's common files.

export interface StagedZip {
  id: string
  fileName: string
  sizeBytes: number
}

/** The ZIP's own name must be usable and end in .zip; its size is checked here, its content by readCompanyZip. */
export async function stageCompanyZip(actor: Actor, input: { fileName: string; bytes: Buffer }, now = new Date()): Promise<StagedZip> {
  const fileName = String(input.fileName ?? '').trim()
  if (!NAME_RE.test(fileName) || !/\.zip$/i.test(fileName)) throw new BadRequestError('Upload a file whose name ends in .zip (letters, digits, spaces, - _ . ( ) are fine).')
  if (!input.bytes?.length) throw new BadRequestError('The ZIP is empty.')
  if (input.bytes.length > MAX_ZIP_BYTES) throw new BadRequestError(`The ZIP is larger than ${MAX_ZIP_BYTES / 1024 / 1024} MB. Split the files into two ZIPs and send them in two campaigns.`)
  const scan = readCompanyZip(input.bytes) // refuses a ZIP that cannot be read at all
  if (!scan.files.some((f) => f.status === 'ok')) {
    const why = scan.files.slice(0, 3).map((f) => `${f.fileName}: ${f.reason}`).join('; ')
    throw new BadRequestError(`The ZIP has no usable PDF files${why ? ` (${why})` : ''}. It should hold one PDF per company, named after the company.`)
  }
  await prisma.bulkAttachment.deleteMany({ where: { tenantId: actor.tenantId, campaignId: null, createdAt: { lt: new Date(now.getTime() - STAGED_KEEP_MS) } } })
  const row = await prisma.bulkAttachment.create({
    data: {
      id: newId(),
      tenantId: actor.tenantId,
      campaignId: null,
      position: 0,
      fileName,
      mimeType: 'application/zip',
      sizeBytes: input.bytes.length,
      sha256: createHash('sha256').update(input.bytes).digest('hex'),
      kind: 'company_zip',
      content: input.bytes,
      createdByCrmUserId: actor.crmUserId,
    },
  })
  rememberScan(row.sha256, scan)
  return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes }
}

/** A staged ZIP without its bytes: name, size and the hash of its content. */
export async function stagedCompanyZipInfo(actor: Actor, id: string): Promise<StagedZip & { sha256: string }> {
  const row = await prisma.bulkAttachment.findFirst({ where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'company_zip' }, select: { id: true, fileName: true, sizeBytes: true, sha256: true } })
  if (!row) throw new BadRequestError('The company ZIP is no longer available. Upload it again.')
  return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes, sha256: row.sha256 }
}

/** A staged ZIP, as its bytes. */
export async function stagedCompanyZip(actor: Actor, id: string): Promise<StagedZip & { bytes: Buffer }> {
  const row = await prisma.bulkAttachment.findFirst({ where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'company_zip' } })
  if (!row) throw new BadRequestError('The company ZIP is no longer available. Upload it again.')
  return { id: row.id, fileName: row.fileName, sizeBytes: row.sizeBytes, bytes: Buffer.from(row.content) }
}

/** Drops a staged ZIP once its send has started (best effort: a day-old staged file is cleared anyway). */
export async function dropStagedZip(actor: Actor, id: string): Promise<void> {
  await prisma.bulkAttachment.deleteMany({ where: { id, tenantId: actor.tenantId, campaignId: null, kind: 'company_zip' } })
}

/** Keeps one company's PDF; returns its id for the recipient. Stored first with no send (campaignId null), tied to its send in one step by linkCompanyFiles. */
export async function storeCompanyFile(actor: Actor, campaignId: string | null, f: ZipFile): Promise<string> {
  if (f.status !== 'ok' || !f.bytes || !f.sha256) throw new BadRequestError(`"${f.fileName}" cannot be used.`)
  const row = await prisma.bulkAttachment.create({
    data: {
      id: newId(),
      tenantId: actor.tenantId,
      campaignId,
      position: 0,
      fileName: f.fileName,
      mimeType: 'application/pdf',
      sizeBytes: f.bytes.length,
      sha256: f.sha256,
      kind: 'company_file',
      content: f.bytes,
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
