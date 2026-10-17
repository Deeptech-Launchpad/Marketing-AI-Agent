import { useRef, useState } from 'react'
import { FileArchive, Paperclip, X } from 'lucide-react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/primitives'
import { uploadZipInPieces } from './zipUpload'

// ATTACHMENTS (2026-10-12): upload once, below the email preview; the same
// files go with every email of the send. Each file is stored on the server as
// soon as it is chosen, and the review and the start name the files by id.

export interface BulkAttachment {
  id: string
  fileName: string
  mimeType: string
  sizeBytes: number
}

/** The ZIP of company-wise PDFs once uploaded (2026-10-17); the server keeps it and the review matches its files to the companies. */
export interface CompanyZip {
  id: string
  fileName: string
  sizeBytes: number
}

export const MAX_ZIP_BYTES = 1024 * 1024 * 1024

/** Why this file cannot be uploaded as the company ZIP (null = it can). Checked again by the server. */
export function zipProblem(file: { name: string; size: number }): string | null {
  if (!/\.zip$/i.test(file.name)) return `"${file.name}" is not a .zip file.`
  if (file.size === 0) return `"${file.name}" is empty.`
  if (file.size > MAX_ZIP_BYTES) return `"${file.name}" is larger than ${formatSize(MAX_ZIP_BYTES)}. Split the PDFs into two ZIPs and send them in two campaigns.`
  return null
}

export const MAX_FILES = 5
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_FILE_BYTES = 7 * 1024 * 1024
const BLOCKED = /\.(exe|bat|cmd|com|scr|pif|msi|msp|dll|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|reg|lnk|hta|cpl|app|apk|sh|bin|iso|dmg)$/i

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

export const attachmentList = (list: BulkAttachment[]) => list.map((a) => `${a.fileName} (${formatSize(a.sizeBytes)})`).join(', ')

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? '').replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(new Error(`"${file.name}" could not be read.`))
    r.readAsDataURL(file)
  })
}

/** Why this file cannot be added to the files already chosen (null = it can). Checked again by the server. */
export function fileProblem(file: { name: string; size: number }, current: BulkAttachment[]): string | null {
  if (BLOCKED.test(file.name)) return `"${file.name}": programs and scripts cannot be attached.`
  if (file.size === 0) return `"${file.name}" is empty.`
  if (file.size > MAX_FILE_BYTES) return `"${file.name}" is larger than ${formatSize(MAX_FILE_BYTES)}.`
  if (current.length >= MAX_FILES) return `At most ${MAX_FILES} files.`
  const total = current.reduce((s, a) => s + a.sizeBytes, 0) + file.size
  if (total > MAX_TOTAL_BYTES) return `All files together must stay under ${formatSize(MAX_TOTAL_BYTES)}.`
  return null
}

export function AttachmentsField({
  value,
  onChange,
  onBusyChange,
  disabled = false,
  zip,
}: {
  value: BulkAttachment[]
  onChange: (next: BulkAttachment[]) => void
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
  /** When given, a second option uploads one ZIP of company-wise PDFs (Bulk email only). */
  zip?: { value: CompanyZip | null; onChange: (next: CompanyZip | null) => void }
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const zipInput = useRef<HTMLInputElement>(null)
  // The ZIP being uploaded in pieces: its name and how many bytes the server has so far.
  const [zipProgress, setZipProgress] = useState<{ name: string; sent: number; total: number } | null>(null)

  const setWorking = (b: boolean) => {
    setBusy(b)
    onBusyChange?.(b)
  }

  const add = async (files: FileList | null) => {
    if (!files?.length) return
    setError(null)
    setWorking(true)
    let next = value
    try {
      for (const f of Array.from(files)) {
        const problem = fileProblem({ name: f.name, size: f.size }, next)
        if (problem) {
          setError(problem)
          break
        }
        const stored = (await api.post('/outreach/bulk/attachments', { fileName: f.name, contentBase64: await readAsBase64(f) })) as BulkAttachment
        next = [...next, stored]
        onChange(next)
      }
    } catch (err) {
      setError((err as Error)?.message || 'The file could not be uploaded.')
    } finally {
      setWorking(false)
      if (input.current) input.current.value = ''
    }
  }

  const remove = async (id: string) => {
    setError(null)
    setWorking(true)
    try {
      await api.del(`/outreach/bulk/attachments/${encodeURIComponent(id)}`)
    } catch {
      // Already gone on the server (for example cleared after a day): it is removed here too.
    } finally {
      onChange(value.filter((a) => a.id !== id))
      setWorking(false)
    }
  }

  const addZip = async (files: FileList | null) => {
    const f = files?.[0]
    if (!f || !zip) return
    setError(null)
    const problem = zipProblem({ name: f.name, size: f.size })
    if (problem) {
      setError(problem)
      if (zipInput.current) zipInput.current.value = ''
      return
    }
    setWorking(true)
    setZipProgress({ name: f.name, sent: 0, total: f.size })
    try {
      const stored = await uploadZipInPieces(f, (sent) => setZipProgress({ name: f.name, sent, total: f.size }))
      const old = zip.value
      zip.onChange(stored)
      // A newer ZIP replaces the earlier one (which is removed from the server; if that fails it is cleared after a day).
      if (old) void api.del(`/outreach/bulk/attachments/${encodeURIComponent(old.id)}`).catch(() => undefined)
    } catch (err) {
      setError((err as Error)?.message || 'The ZIP could not be uploaded.')
    } finally {
      setZipProgress(null)
      setWorking(false)
      if (zipInput.current) zipInput.current.value = ''
    }
  }

  const removeZip = async () => {
    if (!zip?.value) return
    setError(null)
    setWorking(true)
    const id = zip.value.id
    try {
      await api.del(`/outreach/bulk/attachments/${encodeURIComponent(id)}`)
    } catch {
      // Already gone on the server: it is removed here too.
    } finally {
      zip.onChange(null)
      setWorking(false)
    }
  }

  const total = value.reduce((s, a) => s + a.sizeBytes, 0)

  return (
    <section className="bulk-attachments" aria-label="Attachments">
      <p className="field-label">Attachments</p>
      <p className="note">
        Optional. The same files go with every email of this send. Up to {MAX_FILES} files, {formatSize(MAX_TOTAL_BYTES)} in all ({formatSize(MAX_FILE_BYTES)} per file).
        Programs and scripts are blocked.
      </p>
      {value.length > 0 && (
        <ul className="otr-list">
          {value.map((a) => (
            <li key={a.id}>
              <Paperclip size={14} aria-hidden /> {a.fileName} <span className="cell-dim">({formatSize(a.sizeBytes)})</span>{' '}
              <Button size="sm" variant="quiet" icon={X} disabled={disabled || busy} onClick={() => void remove(a.id)}>
                Remove<span className="sr-only"> {a.fileName}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
      {value.length > 0 && <p className="cell-dim">{value.length} file{value.length === 1 ? '' : 's'}, {formatSize(total)} in all</p>}
      {error && (
        <p className="otr-err" role="alert">
          {error}
        </p>
      )}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Choose files to attach"
        onChange={(e) => void add(e.target.files)}
      />
      <div className="row">
        <Button size="sm" icon={Paperclip} disabled={disabled || busy || value.length >= MAX_FILES} busy={busy} onClick={() => input.current?.click()}>
          {value.length ? 'Add another file' : 'Add attachments'}
        </Button>
        {zip && (
          <>
            <input ref={zipInput} type="file" accept=".zip,application/zip" hidden aria-label="Choose the ZIP of company PDFs" onChange={(e) => void addZip(e.target.files)} />
            <Button size="sm" icon={FileArchive} disabled={disabled || busy} busy={busy} onClick={() => zipInput.current?.click()}>
              Upload ZIP (Company-Wise Attachments)
            </Button>
          </>
        )}
      </div>
      {zip && (
        <div className="bulk-zip">
          <p className="note">
            Optional. One ZIP with a PDF for each company, named after the company (for example "ABC Limited.pdf"). Each recipient gets only their own company&rsquo;s PDF, together with
            the files above. Up to {formatSize(MAX_ZIP_BYTES)} in all (each PDF up to {formatSize(MAX_FILE_BYTES)}). A large ZIP is sent in pieces and takes a while; keep this page open.
          </p>
          {zipProgress && (
            <p role="status">
              {zipProgress.sent >= zipProgress.total
                ? `Checking the PDFs in ${zipProgress.name} …`
                : `Uploading ${zipProgress.name} — ${Math.floor((zipProgress.sent / zipProgress.total) * 100)}% (${formatSize(zipProgress.sent)} of ${formatSize(zipProgress.total)})`}
            </p>
          )}
          {zip.value && (
            <p>
              <FileArchive size={14} aria-hidden /> {zip.value.fileName} <span className="cell-dim">({formatSize(zip.value.sizeBytes)})</span>{' '}
              <Button size="sm" variant="quiet" icon={X} disabled={disabled || busy} onClick={() => void removeZip()}>
                Remove<span className="sr-only"> {zip.value.fileName}</span>
              </Button>
            </p>
          )}
        </div>
      )}
    </section>
  )
}
