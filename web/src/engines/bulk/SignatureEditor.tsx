import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import DOMPurify from 'dompurify'
import { ImagePlus } from 'lucide-react'
import { Button } from '../../components/ui/primitives'

// THE SIGNATURE BOX (2026-10-08): paste a signature from Gmail, Outlook or a
// web page and it stays exactly as it looks — lines, spacing, fonts, colours,
// table layout, links and images. A picture can be pasted or added with
// "Insert image". Only code that could run is taken out (the server cleans it
// again and says what, if anything, it removed). The box shows the signature
// in the email's own font, so it looks here as it will in the email.

const PURIFY = {
  FORBID_TAGS: ['style', 'script', 'iframe', 'form', 'object', 'embed', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'svg', 'math'],
  FORBID_ATTR: ['class', 'id'],
}

export const MAX_SIGNATURE_IMAGE_BYTES = 400_000

/** Cleaned HTML, safe to show on this page. */
export function safeHtml(html: string): string {
  return DOMPurify.sanitize(html, PURIFY) as unknown as string
}

/** A plain-text signature (saved before pasting was possible) as HTML lines. */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return text ? text.split('\n').map(esc).join('<br>') : ''
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(new Error('The image could not be read.'))
    r.readAsDataURL(file)
  })
}

/** The signature exactly as the email shows it. */
export function SignatureView({ html }: { html: string }) {
  return <div className="bulk-sig-view" dangerouslySetInnerHTML={{ __html: safeHtml(html) }} />
}

export function SignatureEditor({ initialHtml, onChange }: { initialHtml: string; onChange: (html: string) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)

  // The saved signature is put in once; after that the box is the user's.
  useEffect(() => {
    if (box.current) box.current.innerHTML = safeHtml(initialHtml)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const emit = () => onChange(box.current?.innerHTML ?? '')

  /** Puts HTML where the cursor is (or at the end), as pasted. */
  const insert = (html: string) => {
    const el = box.current
    if (!el) return
    const fragment = document.createRange().createContextualFragment(html)
    const sel = window.getSelection()
    const range = sel && sel.rangeCount ? sel.getRangeAt(0) : null
    if (range && el.contains(range.commonAncestorContainer)) {
      range.deleteContents()
      const last = fragment.lastChild
      range.insertNode(fragment)
      if (last) {
        range.setStartAfter(last)
        range.collapse(true)
        sel!.removeAllRanges()
        sel!.addRange(range)
      }
    } else {
      el.appendChild(fragment)
    }
    emit()
  }

  const addImages = async (files: File[]) => {
    setError(null)
    for (const f of files) {
      if (!/^image\/(png|jpe?g|gif|webp)$/i.test(f.type)) {
        setError(`${f.name || 'That file'} is not a PNG, JPG, GIF or WebP image.`)
        continue
      }
      if (f.size > MAX_SIGNATURE_IMAGE_BYTES) {
        setError(`${f.name || 'The image'} is ${Math.round(f.size / 1000)} KB — images up to ${MAX_SIGNATURE_IMAGE_BYTES / 1000} KB can be embedded.`)
        continue
      }
      insert(`<img src="${await readAsDataUrl(f)}" alt="">`)
    }
  }

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData?.getData('text/html') ?? ''
    if (html.trim()) {
      // The signature as it was copied — layout, styles, links and images.
      e.preventDefault()
      insert(safeHtml(html))
      return
    }
    const images = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'))
    if (images.length) {
      e.preventDefault()
      void addImages(images)
    }
    // Plain text: the browser pastes it, line breaks included.
  }

  return (
    <>
      <div
        ref={box}
        className="bulk-sig-editor"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Signature"
        onInput={emit}
        onPaste={onPaste}
      />
      <div className="row" style={{ marginTop: 'var(--s1)' }}>
        <Button size="sm" variant="quiet" icon={ImagePlus} onClick={() => picker.current?.click()}>
          Insert image
        </Button>
        <input
          ref={picker}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          aria-label="Signature image"
          style={{ display: 'none' }}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            void addImages(files)
          }}
        />
        {error && (
          <span className="otr-err" role="alert">
            {error}
          </span>
        )}
      </div>
    </>
  )
}
