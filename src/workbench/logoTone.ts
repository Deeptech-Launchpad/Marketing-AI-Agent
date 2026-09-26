import { inflateSync } from 'node:zlib'

/**
 * IS THIS LOGO MEANT FOR A DARK HEADER?
 *
 * Plenty of shops publish their mark in white, because their own masthead is a
 * dark bar. Drawn on our white header it disappears, and the customer sees a
 * page with no logo at all — which reads worse than no branding.
 *
 * So the picture itself is asked: the mean brightness of the pixels that are
 * actually painted (transparent ones say nothing about the mark). A mark that
 * is nearly all white needs a dark plate behind it, exactly as its own site
 * gives it.
 *
 * PNG only, which is what mastheads are published as. Anything else — JPEG,
 * WebP, SVG, a picture we could not read — answers null, and the page is drawn
 * the way it is drawn today rather than guessed at.
 */
export type LogoTone = 'light' | 'dark'

/** Painted pixels brighter than this read as a mark made for a dark bar. */
const LIGHT_AT = 0.72
/** Below this share of painted pixels there is nothing to judge. */
const MIN_PAINTED = 12
/**
 * How much of the picture must be transparent before it counts as a cut-out.
 *
 * A logo that carries its own background — a white plate with dark type on it —
 * shows perfectly well on our white header and must be left alone. Only a mark
 * cut out of transparency can disappear into the page.
 */
const MIN_CLEAR = 0.15

export function logoToneOf(dataUri: string | null | undefined): LogoTone | null {
  if (!dataUri || !dataUri.startsWith('data:image/png;base64,')) return null
  try {
    const png = Buffer.from(dataUri.slice(dataUri.indexOf(',') + 1), 'base64')
    return toneOfPng(png)
  } catch {
    return null
  }
}

export function toneOfPng(png: Buffer): LogoTone | null {
  if (png.length < 33 || png.readUInt32BE(0) !== 0x89504e47) return null

  let width = 0
  let height = 0
  let depth = 0
  let colour = -1
  let interlace = 0
  const idat: Buffer[] = []

  for (let at = 8; at + 8 <= png.length; ) {
    const length = png.readUInt32BE(at)
    const type = png.toString('ascii', at + 4, at + 8)
    const body = png.subarray(at + 8, at + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      depth = body[8]!
      colour = body[9]!
      interlace = body[12]!
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    at += 12 + length
  }

  // 8 bits per channel, not interlaced, and one of the colour types that
  // carries brightness directly. Palettes and 16-bit depths are left alone.
  const channels = colour === 0 ? 1 : colour === 2 ? 3 : colour === 4 ? 2 : colour === 6 ? 4 : 0
  if (!channels || depth !== 8 || interlace !== 0 || !width || !height || !idat.length) return null

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null

  const line = Buffer.alloc(stride)
  const previous = Buffer.alloc(stride)
  let painted = 0
  let clear = 0
  let brightness = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    raw.copy(line, 0, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    unfilter(filter, line, previous, channels)
    for (let x = 0; x < stride; x += channels) {
      const alpha = channels === 2 ? line[x + 1]! : channels === 4 ? line[x + 3]! : 255
      if (alpha < 32) {
        clear += 1
        continue
      }
      const value =
        channels <= 2
          ? line[x]! / 255
          : (0.2126 * line[x]! + 0.7152 * line[x + 1]! + 0.0722 * line[x + 2]!) / 255
      painted += 1
      brightness += value
    }
    line.copy(previous)
  }

  if (painted < MIN_PAINTED) return null
  const cutOut = clear / (painted + clear) >= MIN_CLEAR
  return cutOut && brightness / painted > LIGHT_AT ? 'light' : 'dark'
}

/** Undoes a PNG scanline filter, in place. */
function unfilter(filter: number, line: Buffer, previous: Buffer, channels: number): void {
  for (let i = 0; i < line.length; i++) {
    const a = i >= channels ? line[i - channels]! : 0
    const b = previous[i]!
    const c = i >= channels ? previous[i - channels]! : 0
    const x = line[i]!
    if (filter === 1) line[i] = (x + a) & 0xff
    else if (filter === 2) line[i] = (x + b) & 0xff
    else if (filter === 3) line[i] = (x + ((a + b) >> 1)) & 0xff
    else if (filter === 4) line[i] = (x + paeth(a, b, c)) & 0xff
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
