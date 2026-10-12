import { describe, expect, it } from 'vitest'
import { cleanTemplateHtml, composeCustomEmail, MAX_CUSTOM_HTML, MAX_CUSTOM_SUBJECT, prepareCustomTemplate } from '../../src/outreach/bulk/customTemplate.js'

// "USE MY OWN TEMPLATE" (2026-10-12): the user's pasted email is cleaned once
// on the server, then every recipient gets the same email with only
// [First Name] and [Company Name] filled in.

describe('cleaning a pasted template', () => {
  it('keeps formatting people paste: bold, italics, lists, links, tables, colours, spacing', () => {
    const html =
      '<p style="margin:0 0 12px;color:#123456">Hi <b>[First Name]</b>,</p><ul><li>One</li><li><i>Two</i></li></ul>' +
      '<p><a href="https://example.com/offer?a=1&b=2">our offer</a> or <a href="mailto:sales@example.com">mail us</a></p>' +
      '<table border="1"><tbody><tr><td style="width:50%">A</td><td>B</td></tr></tbody></table>'
    const out = cleanTemplateHtml(html)
    expect(out.removed).toEqual([])
    expect(out.html).toContain('<b>[First Name]</b>')
    expect(out.html).toContain('<ul><li>One</li>')
    expect(out.html).toContain('href="https://example.com/offer?a=1&amp;b=2"')
    expect(out.html).toContain('href="mailto:sales@example.com"')
    expect(out.html).toContain('<table border="1">')
    expect(out.html).toContain('color:#123456')
  })

  it('removes scripts, event handlers, javascript: links, forms, frames and objects — and says so', () => {
    const html =
      '<p onclick="steal()">Hello</p><script>alert(1)</script><a href="javascript:alert(1)">x</a>' +
      '<form action="https://evil.test"><input name="a"></form><iframe src="https://evil.test"></iframe><object data="x"></object><embed src="x">'
    const out = cleanTemplateHtml(html)
    expect(out.html).not.toMatch(/<script|onclick|javascript:|<form|<input|<iframe|<object|<embed|alert/i)
    expect(out.html).toContain('Hello')
    expect(out.removed).toContain('scripts and active content')
  })

  it('removes style rules that load outside content, keeps the rest of the style', () => {
    const out = cleanTemplateHtml('<p style="color:red;background:url(http://evil.test/x.png);width:expression(alert(1))">x</p>')
    expect(out.html).toContain('color:red')
    expect(out.html).not.toMatch(/evil\.test|expression/i)
    expect(out.removed).toContain('style rules that load outside content')
  })

  it('images: only https links stay; a pasted (data:), saved (file:) or http picture is removed with an instruction', () => {
    const out = cleanTemplateHtml(
      '<img src="https://cdn.example.com/logo.png" alt="Logo"><img src="data:image/png;base64,AAAA"><img src="file:///C:/a.png"><img src="http://cdn.example.com/b.png">',
    )
    expect(out.html).toContain('src="https://cdn.example.com/logo.png"')
    expect(out.html).not.toMatch(/data:|file:|http:\/\//)
    expect(out.removed.join(' ')).toMatch(/not a link to the web/)
  })

  it('drops classes, ids and unknown attributes and tags', () => {
    const out = cleanTemplateHtml('<div class="x" id="y" data-a="1"><p>ok</p><blink>b</blink></div>')
    expect(out.html).toBe('<div><p>ok</p>b</div>')
  })
})

describe('preparing what the user entered', () => {
  const ok = { subject: 'Quick idea for [Company Name]', bodyHtml: '<p>Hi [First Name],</p><p>Our offer.</p>' }

  it('returns the cleaned template with its plain text, placeholders still in place', () => {
    const t = prepareCustomTemplate(ok)
    expect(t.subject).toBe('Quick idea for [Company Name]')
    expect(t.html).toContain('[First Name]')
    expect(t.text).toBe('Hi [First Name],\n\nOur offer.')
  })

  it('refuses an empty or multi-line or too long subject, and an empty or oversize or text-less body', () => {
    expect(() => prepareCustomTemplate({ ...ok, subject: '  ' })).toThrow(/Enter the subject/)
    expect(() => prepareCustomTemplate({ ...ok, subject: 'a\nb' })).toThrow(/one line/)
    expect(() => prepareCustomTemplate({ ...ok, subject: 'x'.repeat(MAX_CUSTOM_SUBJECT + 1) })).toThrow(/longer than/)
    expect(() => prepareCustomTemplate({ ...ok, bodyHtml: '' })).toThrow(/Paste the body/)
    expect(() => prepareCustomTemplate({ ...ok, bodyHtml: '<p> </p><script>alert(1)</script>' })).toThrow(/Paste the body/)
    expect(() => prepareCustomTemplate({ ...ok, bodyHtml: 'x'.repeat(MAX_CUSTOM_HTML + 1) })).toThrow(/too long/)
  })
})

describe('composing one person\'s email from the template', () => {
  const template = prepareCustomTemplate({ subject: 'Quick idea for [Company Name]', bodyHtml: '<p>Hi <b>[First Name]</b>,</p><p>About [Company Name]: <a href="https://example.com/x">details</a></p>' })

  it('fills only [First Name] and [Company Name], in the subject and the body, and nothing else changes', () => {
    const e = composeCustomEmail({ template, firstName: 'Priya', companyName: 'Acme Supply' })
    expect(e.subject).toBe('Quick idea for Acme Supply')
    expect(e.unfilled).toEqual([])
    expect(e.html).toContain('<b>Priya</b>')
    expect(e.html).toContain('About Acme Supply: <a href="https://example.com/x">details</a>')
    expect(e.text).toBe('Hi Priya,\n\nAbout Acme Supply: details')
    expect(e.html.startsWith('<div style="font-family:Verdana')).toBe(true)
  })

  it('escapes the values: a company called A&B <script> cannot inject markup', () => {
    const e = composeCustomEmail({ template, firstName: 'Ann "the" Lee', companyName: 'A&B <script>alert(1)</script>' })
    expect(e.html).toContain('A&amp;B &lt;script&gt;alert(1)&lt;/script&gt;')
    expect(e.html).not.toMatch(/<script/i)
    expect(e.html).toContain('Ann &quot;the&quot; Lee')
    expect(e.subject).toBe('Quick idea for A&B <script>alert(1)</script>') // the subject is plain text, as for the approved versions
  })

  it('every recipient gets the same email: only their own values differ', () => {
    const a = composeCustomEmail({ template, firstName: 'Ann', companyName: 'Alpha' })
    const b = composeCustomEmail({ template, firstName: 'Bob', companyName: 'Bravo' })
    expect(a.html.replace(/Ann|Alpha/g, '#')).toBe(b.html.replace(/Bob|Bravo/g, '#'))
    expect(a.text.replace(/Ann|Alpha/g, '#')).toBe(b.text.replace(/Bob|Bravo/g, '#'))
  })

  it('a blank value is reported, never sent as a bracket', () => {
    expect(composeCustomEmail({ template, firstName: null, companyName: 'Acme' }).unfilled).toEqual(['[First Name]'])
    expect(composeCustomEmail({ template, firstName: ' ', companyName: '' }).unfilled.sort()).toEqual(['[Company Name]', '[First Name]'])
  })

  it('a template without placeholders is sent word for word, to everyone', () => {
    const plain = prepareCustomTemplate({ subject: 'Hello', bodyHtml: '<p>Same for all.</p>' })
    const a = composeCustomEmail({ template: plain, firstName: 'Ann', companyName: 'Alpha' })
    const b = composeCustomEmail({ template: plain, firstName: 'Bob', companyName: 'Bravo' })
    expect(a).toEqual(b)
    expect(a.unfilled).toEqual([])
  })

  it('adds the sender signature under it on the SMTP path, and nothing through NXT Sales (empty signature)', () => {
    const smtp = composeCustomEmail({ template, firstName: 'Ann', companyName: 'Alpha', signature: 'Manoj S\nAltiusNxt', signatureHtml: '<b>Manoj S</b>' })
    expect(smtp.html).toContain('<div><br></div><div><b>Manoj S</b></div>')
    expect(smtp.text.endsWith('\n\nManoj S\nAltiusNxt')).toBe(true)
    const crm = composeCustomEmail({ template, firstName: 'Ann', companyName: 'Alpha', signature: '', signatureHtml: '' })
    expect(crm.html).not.toContain('<div><br></div>')
    expect(crm.text).toBe('Hi Ann,\n\nAbout Alpha: details')
  })

  it('adds no footer, link or other text of its own — and no "register here" rewriting', () => {
    const t = prepareCustomTemplate({ subject: 'S', bodyHtml: '<p>Please register here today.</p>' })
    const e = composeCustomEmail({ template: t, firstName: 'Ann', companyName: 'Alpha' })
    expect(e.html).toBe('<div style="font-family:Verdana,Geneva,sans-serif;font-size:14px;line-height:1.5;color:#222"><p>Please register here today.</p></div>')
    expect(e.html).not.toMatch(/b2becommerceworld|unsubscribe/i)
  })
})
