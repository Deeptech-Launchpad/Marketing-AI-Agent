import { useEffect, useRef, useState, type ClipboardEvent } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '../../components/ui/primitives'
import { safeHtml } from './SignatureEditor'

// "USE MY OWN TEMPLATE" (2026-10-12): instead of the approved Versions 1, 2 and
// 3, the user types a subject and pastes their existing email — straight from
// Gmail, Outlook or Word, formatting included. The email is then shown in full
// in the preview, reviewed and approved, and the SAME email goes to every
// recipient with only [First Name] and [Company Name] filled in. The server
// cleans the pasted email again; this box only keeps it from running code here.
//
// SEVERAL OWN TEMPLATES (2026-10-14): a bulk send may use up to 3 own
// templates, given in order (1 → 2 → 3 → 1 …) or at random. The random order is
// fixed by a seed chosen here, so the start sends exactly what was reviewed.
// "Send to one person" keeps one template.

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

/** One template's subject and body box. The body is put into the box once; after that the box is the user's. */
function TemplateEditor({ value, label, onChange }: { value: CustomTemplateValue; label: string; onChange: (next: Partial<CustomTemplateValue>) => void }) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (box.current) box.current.innerHTML = safeHtml(value.bodyHtml)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    onChange({ bodyHtml: el.innerHTML })
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
    <>
      <label>
        <span className="field-label">Subject</span>
        <input
          className="otr-input"
          aria-label={`${label} subject`}
          maxLength={200}
          value={value.subject}
          onChange={(e) => onChange({ subject: e.target.value.replace(/[\r\n]+/g, ' ') })}
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
        aria-label={`${label} body`}
        onInput={() => onChange({ bodyHtml: box.current?.innerHTML ?? '' })}
        onPaste={onPaste}
      />
    </>
  )
}

const HINT = (
  <p className="note">
    Paste your existing email here (from Gmail, Outlook or Word), or type it. <strong>[First Name]</strong> and <strong>[Company Name]</strong> are filled for each
    person from your Excel file; everything else goes exactly as written, to every recipient. Pictures must be links to images on the web.
  </p>
)

function ModeChoice({ own, onApproved, onOwn, approvedLabel }: { own: boolean; onApproved: () => void; onOwn: () => void; approvedLabel: string }) {
  return (
    <>
      <legend className="field-label">Email template</legend>
      <label className="otr-check">
        <input type="radio" name="bulk-template-mode" checked={!own} onChange={onApproved} />
        <span>{approvedLabel}</span>
      </label>
      <label className="otr-check">
        <input type="radio" name="bulk-template-mode" checked={own} onChange={onOwn} />
        <span>Use my own template</span>
      </label>
    </>
  )
}

/** One own template (Send to one person). */
export function EmailTemplateField({
  value,
  onChange,
  disabled = false,
}: {
  /** null = the approved Versions 1, 2 and 3. */
  value: CustomTemplateValue | null
  onChange: (next: CustomTemplateValue | null) => void
  disabled?: boolean
}) {
  // What was typed stays when the user switches back and forth.
  const draft = useRef<CustomTemplateValue>(value ?? { subject: '', bodyHtml: '' })
  if (value) draft.current = value
  const [, bump] = useState(0)

  const emit = (next: Partial<CustomTemplateValue>) => {
    draft.current = { ...draft.current, ...next }
    onChange({ ...draft.current })
    bump((n) => n + 1)
  }

  return (
    <fieldset className="bulk-template" disabled={disabled}>
      <ModeChoice own={value !== null} onApproved={() => onChange(null)} onOwn={() => emit({})} approvedLabel="Approved emails Version 1, 2 and 3 (given in turn)" />
      {value !== null && (
        <div className="bulk-template-own">
          <TemplateEditor value={value} label="Template" onChange={emit} />
          {HINT}
        </div>
      )}
    </fieldset>
  )
}

// ── Bulk email: 1-3 own templates ───────────────────────────────────────────

export type TemplateOrder = 'sequential' | 'random'
export const MAX_OWN_TEMPLATES = 3

export interface OwnTemplates {
  templates: Array<CustomTemplateValue & { id: number }>
  order: TemplateOrder
  /** Fixes the random order; a new one is drawn each time Random is chosen. */
  seed: number
}

export function newSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff)
}

/** Whether every template can be reviewed. */
export function ownTemplatesReady(v: OwnTemplates | null): boolean {
  return v === null || v.templates.every((t) => customTemplateReady(t))
}

/** What the server is sent: one template exactly as before, or the list with its order. */
export function ownTemplatesRequest(v: OwnTemplates | null): Record<string, unknown> {
  if (!v) return {}
  const list = v.templates.map((t) => ({ subject: t.subject.trim(), bodyHtml: t.bodyHtml }))
  if (list.length === 1) return { customTemplate: list[0] }
  return { customTemplates: list, templateOrder: v.order, ...(v.order === 'random' ? { shuffleSeed: v.seed } : {}) }
}

export function EmailTemplatesField({ value, onChange }: { value: OwnTemplates | null; onChange: (next: OwnTemplates | null) => void }) {
  // What was typed stays when the user switches back and forth.
  const draft = useRef<OwnTemplates>(value ?? { templates: [{ id: 1, subject: '', bodyHtml: '' }], order: 'sequential', seed: newSeed() })
  if (value) draft.current = value
  const set = (next: OwnTemplates) => {
    draft.current = next
    onChange(next)
  }
  const patch = (id: number, p: Partial<CustomTemplateValue>) => set({ ...draft.current, templates: draft.current.templates.map((t) => (t.id === id ? { ...t, ...p } : t)) })
  const add = () => {
    const id = Math.max(0, ...draft.current.templates.map((t) => t.id)) + 1
    set({ ...draft.current, templates: [...draft.current.templates, { id, subject: '', bodyHtml: '' }] })
  }
  const remove = (id: number) => set({ ...draft.current, templates: draft.current.templates.filter((t) => t.id !== id) })
  const multi = (value?.templates.length ?? 0) > 1

  return (
    <fieldset className="bulk-template">
      <ModeChoice own={value !== null} onApproved={() => onChange(null)} onOwn={() => set(draft.current)} approvedLabel="Approved emails Version 1, 2 and 3 (given in turn)" />
      {value !== null && (
        <div className="bulk-template-own">
          {value.templates.map((t, i) => (
            <div key={t.id} className="bulk-template-item">
              {multi && (
                <div className="row bulk-template-head">
                  <strong>Template {i + 1}</strong>
                  <Button size="sm" variant="quiet" onClick={() => remove(t.id)}>
                    Remove<span className="sr-only"> template {i + 1}</span>
                  </Button>
                </div>
              )}
              <TemplateEditor value={t} label={multi ? `Template ${i + 1}` : 'Template'} onChange={(p) => patch(t.id, p)} />
            </div>
          ))}
          {value.templates.length < MAX_OWN_TEMPLATES && (
            <Button size="sm" variant="quiet" icon={Plus} onClick={add}>
              Add another template
            </Button>
          )}
          {multi && (
            <fieldset className="bulk-template-order">
              <legend className="field-label">How the templates are given out</legend>
              <label className="otr-check">
                <input type="radio" name="bulk-template-order" checked={value.order === 'sequential'} onChange={() => set({ ...draft.current, order: 'sequential' })} />
                <span>In order: template {value.templates.map((_, i) => i + 1).join(' → ')} → 1 … down the list</span>
              </label>
              <label className="otr-check">
                <input type="radio" name="bulk-template-order" checked={value.order === 'random'} onChange={() => set({ ...draft.current, order: 'random', seed: newSeed() })} />
                <span>Random: each person gets one of the templates at random (fixed when you review — what you see is what is sent)</span>
              </label>
            </fieldset>
          )}
          {HINT}
        </div>
      )}
    </fieldset>
  )
}
