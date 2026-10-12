import { createHash } from 'node:crypto'
import { prisma, newId } from '../../platform/db.js'
import { BadRequestError, ConflictError, NotFoundError } from '../../platform/errors.js'

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

// No control characters, quotes, slashes or other header/path-significant characters.
// eslint-disable-next-line no-control-regex
const NAME_RE = /^[^\x00-\x1f\x7f"\\/<>:*?|]{1,150}$/
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
    where: { id: { in: list }, tenantId: actor.tenantId, campaignId: null },
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
    const r = await prisma.bulkAttachment.updateMany({ where: { id, tenantId: actor.tenantId, campaignId: null }, data: { campaignId, position } })
    if (r.count !== 1) throw new ConflictError('An attachment is no longer available. Nothing was sent; upload it again and start again.')
  }
}

/** The files of a send, in order, as they travel with each email. */
export async function campaignAttachments(campaignId: string): Promise<AttachmentFile[]> {
  const rows = await prisma.bulkAttachment.findMany({ where: { campaignId }, orderBy: { position: 'asc' } })
  return rows.map((r) => ({ filename: r.fileName, mimeType: r.mimeType, content: Buffer.from(r.content).toString('base64') }))
}

/** For the screens: name and size of each file of a send. */
export async function campaignAttachmentInfo(campaignId: string): Promise<AttachmentInfo[]> {
  const rows = await prisma.bulkAttachment.findMany({
    where: { campaignId },
    orderBy: { position: 'asc' },
    select: { id: true, fileName: true, mimeType: true, sizeBytes: true },
  })
  return rows.map(info)
}
