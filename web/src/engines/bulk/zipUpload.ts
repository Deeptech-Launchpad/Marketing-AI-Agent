import { api, ApiError } from '../../lib/api'

// UPLOADING A ZIP OF COMPANY-WISE PDFs (up to 1 GB), IN PIECES (2026-10-18).
//
// A ZIP of a gigabyte cannot go in one request (the web server accepts 25 MB, and
// a single long request breaks on any dropped connection). The file is cut into
// pieces the server names (16 MB), sent one after the other, each at the offset
// where the server's copy ends. If a piece fails, only that piece is tried
// again; if the server says it already has more or less than expected (an answer
// was lost), the upload carries on from where the SERVER says it is. Finally the
// server checks the whole file and reads it as a ZIP.

export interface UploadedZip {
  id: string
  fileName: string
  sizeBytes: number
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A piece is tried again this many times in a row; with the waits below that is about two minutes of trouble (Wi-Fi switch, VPN, a short outage). */
const MAX_FAILURES = 8
/** 1, 2, 4, 8, 16, 30, 30, 30 seconds (scaled by `pause`). */
const backoff = (pause: number, failures: number) => Math.min(pause * 1.25 * 2 ** (failures - 1), pause * 37.5)

/** How many bytes the server says it has, when it answered 409 to a piece or to finish. */
function serverHas(err: unknown): number | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null
  const n = (err.detail as { error?: { details?: { receivedBytes?: unknown } } } | null)?.error?.details?.receivedBytes
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

/** A failure worth trying again: the connection dropped, a gateway timed out, or the server asked to slow down. */
const worthRetrying = (err: unknown) => err instanceof ApiError && (err.status === 0 || err.status === 429 || err.status >= 500)

export async function uploadZipInPieces(
  file: File,
  onProgress: (sentBytes: number) => void,
  opts: { pauseMs?: number } = {},
): Promise<UploadedZip> {
  const pause = opts.pauseMs ?? 800
  const started = await api.post<{ id: string; chunkBytes: number }>('/outreach/bulk/attachments/zip/start', { fileName: file.name, sizeBytes: file.size })
  const base = `/outreach/bulk/attachments/zip/${encodeURIComponent(started.id)}`
  try {
    let offset = 0
    let failures = 0
    let redirects = 0
    onProgress(0)
    while (offset < file.size) {
      const piece = file.slice(offset, Math.min(file.size, offset + started.chunkBytes))
      if (piece.size === 0) throw new Error(`"${file.name}" could not be read.`)
      try {
        await api.upload(`${base}/chunk?offset=${offset}`, piece, { contentType: 'application/octet-stream' })
        offset += piece.size
        failures = 0
        redirects = 0
      } catch (err) {
        const have = serverHas(err)
        if (have !== null && have <= file.size) {
          // The server knows better where the file ends: carry on from there (never more than a few times without moving).
          if (have === offset && ++redirects > 3) throw err
          offset = have
          continue
        }
        if (!worthRetrying(err) || ++failures > MAX_FAILURES) throw err
        await wait(backoff(pause, failures))
      }
      onProgress(offset)
    }
    // The server now checks the whole file; if the answer is slow to come back it is simply asked again (it answers the same).
    for (let attempt = 1; ; attempt++) {
      try {
        return await api.post<UploadedZip>(`${base}/finish`, {})
      } catch (err) {
        if (!worthRetrying(err) || attempt >= 4) throw err
        await wait(pause * attempt)
      }
    }
  } catch (err) {
    // Nothing is left behind on the server for an upload that did not finish.
    void api.del(`/outreach/bulk/attachments/${encodeURIComponent(started.id)}`).catch(() => undefined)
    throw err
  }
}
