import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { safeHtml } from './SignatureEditor'

// "USE MY OWN TEMPLATE" (2026-10-12): instead of the approved Versions 1, 2 and
// 3, the user types a subject and pastes their existing email — straight from
// Gmail, Outlook or Word, formatting included. The email is then shown in full
// in the preview, reviewed and approved, and the SAME email goes to every
// recipient with only [First Name] and [Company Name] filled in. The server
// cleans the pasted email again; this box only keeps it from running code here.

export interface CustomTemplateValue {
  subject: string
  bodyHtml: string
}

/** The text a pasted body contains, without markup. */
export function visibleText(html: string): string {
  return new DOMParser().parseFromString(html || '', 'text/html').body.textContent?.trim() ?? ''
}

/** Whether the template can be reviewed: a subject and some text in the body. */
export function customTemplateReady(v: CustomTemplateValue | null): boolean {
  return v === null || Boolean(v.subject.trim() && visibleText(v.bodyHtml))
}

export function EmailTemplateField({
  value,
  onChange,
  disabled = false,
}: {
  /** null = the approved Versions 1, 2 and 3 (in turn). */
  value: CustomTemplateValue | null
  onChange: (next: CustomTemplateValue | null) => void
  disabled?: boolean
}) {
  const own = value !== null
  // What was typed stays when the user switches back and forth.
  const draft = useRef<CustomTemplateValue>(value ?? { subject: '', bodyHtml: '' })
  if (value) draft.current = value
  const box = useRef<HTMLDivElement>(null)
  const [, bump] = useState(0)

  // The saved body is put into the box once, when it opens; after that the box is the user's.
  useEffect(() => {
    if (own && box.current) box.current.innerHTML = safeHtml(draft.current.bodyHtml)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [own])

  const emit = (next: Partial<CustomTemplateValue>) => {
    draft.current = { ...draft.current, ...next }
    onChange({ ...draft.current })
    bump((n) => n + 1)
  }

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
    emit({ bodyHtml: el.innerHTML })
  }

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const html = e.clipboardData?.getData('text/html') ?? ''
    if (html.trim()) {
      // The email as it was copied: its layout, styles and links.
      e.preventDefault()
      insert(safeHtml(html))
    }
    // Plain text: the browser pastes it, line breaks included.
  }

  return (
    <fieldset className="bulk-template" disabled={disabled}>
      <legend className="field-label">Email template</legend>
      <label className="otr-check">
        <input type="radio" name="bulk-template-mode" checked={!own} onChange={() => onChange(null)} />
        <span>Approved emails Version 1, 2 and 3 (given in turn)</span>
      </label>
      <label className="otr-check">
        <input type="radio" name="bulk-template-mode" checked={own} onChange={() => emit({})} />
        <span>Use my own template</span>
      </label>
      {value !== null && (
        <div className="bulk-template-own">
          <label>
            <span className="field-label">Subject</span>
            <input
              className="otr-input"
              aria-label="Template subject"
              maxLength={200}
              value={value.subject}
              onChange={(e) => emit({ subject: e.target.value.replace(/[\r\n]+/g, ' ') })}
              placeholder="For example: A quick idea for [Company Name]"
            />
          </label>
          <span className="field-label">Email body</span>
          <div
            ref={box}
            className="bulk-sig-editor bulk-template-body"
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-label="Template body"
            onInput={() => emit({ bodyHtml: box.current?.innerHTML ?? '' })}
            onPaste={onPaste}
          />
          <p className="note">
            Paste your existing email here (from Gmail, Outlook or Word), or type it. <strong>[First Name]</strong> and <strong>[Company Name]</strong> are filled for
            each person from your Excel file; everything else goes exactly as written, to every recipient. Pictures must be links to images on the web.
          </p>
        </div>
      )}
    </fieldset>
  )
}
