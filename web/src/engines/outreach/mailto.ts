// HANDING AN APPROVED EMAIL TO THE PERSON WHO WILL SEND IT.
//
// Nothing here sends anything. It puts the email where Sales can send it from
// their own account: on the clipboard, or in a Gmail compose window with the
// recipient, subject and body already filled in.

/** Gmail's compose window, with the fields filled in. */
export function buildGmailCompose(to: string | null, subject: string | null, body: string): string {
  // Gmail reads these as ordinary query parameters, and URLSearchParams is
  // wrong for them for the same reason as below: it writes spaces as "+",
  // which Gmail then shows literally in the subject line.
  const params = [
    'view=cm',
    'fs=1',
    'tf=1',
    to ? `to=${encodeURIComponent(to)}` : null,
    subject ? `su=${encodeURIComponent(subject)}` : null,
    `body=${encodeURIComponent(body)}`,
  ].filter((p): p is string => p !== null)
  return `https://mail.google.com/mail/?${params.join('&')}`
}

// A mailto: link for the same email.
//
// It opens whatever mail program the computer is set up with. That is nothing
// at all on a machine with none configured, which is why Gmail is offered
// first and this is kept as the alternative for Outlook and the like.
//
// encodeURIComponent, not URLSearchParams: the latter writes spaces as "+",
// which several mail clients show literally.
export function buildMailto(to: string | null, subject: string | null, body: string): string {
  const params: string[] = []
  if (subject) params.push(`subject=${encodeURIComponent(subject)}`)
  // Mail clients expect CRLF line breaks in a mailto body.
  params.push(`body=${encodeURIComponent(body.replace(/\r?\n/g, '\r\n'))}`)
  return `mailto:${to ? encodeURIComponent(to).replace(/%40/g, '@') : ''}?${params.join('&')}`
}

/** The email as plain text, for the clipboard. */
export function asPlainText(to: string | null, subject: string | null, body: string): string {
  return [to ? `To: ${to}` : null, subject ? `Subject: ${subject}` : null, '', body].filter((l) => l !== null).join('\n')
}

/**
 * Copies text, and says truthfully whether it worked.
 *
 * WHY THIS IS NOT ONE LINE OF navigator.clipboard.
 *
 * That API exists only in a "secure context" — HTTPS, or localhost. This
 * platform is served over plain HTTP on an IP address, so on the live server
 * `navigator.clipboard` is undefined. Written as `navigator.clipboard?.write…`
 * that silently evaluates to undefined, nothing is copied, no error is raised,
 * and the button cheerfully says "Copied" — which is exactly what it did.
 *
 * So: use the real API where it exists, fall back to the old execCommand path
 * where it does not, and return false when neither worked so the caller can
 * say so instead of claiming success.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Denied, or not permitted from this context. Try the fallback.
    }
  }

  // The pre-clipboard-API way, which still works on plain HTTP. It needs a
  // real element in the document and a live user gesture, which a click
  // handler is.
  try {
    const area = document.createElement('textarea')
    area.value = text
    // Off-screen rather than hidden: an element with display:none or
    // visibility:hidden cannot be selected, and the copy silently does nothing.
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '-1000px'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}
