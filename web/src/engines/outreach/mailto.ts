// A mailto: link for an approved email.
//
// It opens the person's OWN mail client with the recipient, subject and body
// filled in. Nothing is sent by this platform — the person reads it once more
// and presses send in their own mail program, then marks it sent here.
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
