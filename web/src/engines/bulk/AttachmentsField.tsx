import { useRef, useState } from 'react'
import { Paperclip, X } from 'lucide-react'
import { api } from '../../lib/api'
import { Button } from '../../components/ui/primitives'

// ATTACHMENTS (2026-10-12): upload once, below the email preview; the same
// files go with every email of the send. Each file is stored on the server as
// soon as it is chosen, and the review and the start name the files by id.

export interface BulkAttachment {
  id: string
  fileName: string
  mimeType: string
  sizeBytes: number
}

export const MAX_FILES = 5
export const MAX_TOTAL_BYTES = 10 * 1024 * 1024
export const MAX_FILE_BYTES = 7 * 1024 * 1024
const BLOCKED = /\.(exe|bat|cmd|com|scr|pif|msi|msp|dll|jar|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|reg|lnk|hta|cpl|app|apk|sh|bin|iso|dmg)$/i

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
}: {
  value: BulkAttachment[]
  onChange: (next: BulkAttachment[]) => void
  onBusyChange?: (busy: boolean) => void
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

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
      <Button size="sm" icon={Paperclip} disabled={disabled || busy || value.length >= MAX_FILES} busy={busy} onClick={() => input.current?.click()}>
        {value.length ? 'Add another file' : 'Add attachments'}
      </Button>
    </section>
  )
}
