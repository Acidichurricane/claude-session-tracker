// Pixel art and colour for the HUD: procedural agent avatars, the context bar,
// gauges. Pure functions, so tests run them directly.

export const NEON = {
  cyan: '#22d3ee',
  magenta: '#e879f9',
  lime: '#a3e635',
  amber: '#fbbf24',
  red: '#f87171',
  dim: '#64748b',
  frame: '#0e7490',
  frameAlt: '#86198f',
} as const

const BG = 0x0b1020

// FNV-1a: a stable 32-bit hash so an agent keeps its face across redraws and sessions.
export function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function rng(seed: number) {
  let a = seed || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hsl(h: number, s: number, l: number): number {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255)
}

function dimRgb(c: number, k: number): number {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255
  return (Math.round(r * k) << 16) | (Math.round(g * k) << 8) | Math.round(b * k)
}

export const toHex = (c: number) => `#${c.toString(16).padStart(6, '0')}`

export type AvatarMood = 'live' | 'idle' | 'done' | 'fail' | 'stop' | 'core'

// The robot's frame: 1 = always lit (head outline), 2 = eye, 0 = random fill.
// Left half only; mirrored to 8 columns.
const TEMPLATE = [
  [0, 0, 1, 1],
  [0, 1, 0, 0],
  [1, 0, 2, 0],
  [1, 0, 0, 0],
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 1, 0, 1],
  [1, 0, 0, 0],
]

/** 8x8 pixel face for `seed`, as Raster words: 8 columns x 4 rows of half blocks.
 *  `frame` animates a working face: every fifth frame it blinks. */
export function avatarWords(seed: string, mood: AvatarMood, frame = 0): number[] {
  const h = hash(seed)
  const r = rng(h)
  const hue = mood === 'fail' ? 0 : mood === 'stop' ? 40 : mood === 'core' ? 190 : h % 360
  let main = hsl(hue, 0.85, 0.6)
  let accent = hsl((hue + 150) % 360, 0.9, 0.66)
  let eye = mood === 'fail' ? 0xffd166 : 0xe6fbff
  if (mood === 'done' || mood === 'idle') {
    const k = mood === 'done' ? 0.5 : 0.75
    main = dimRgb(main, k)
    accent = dimRgb(accent, k)
    eye = dimRgb(eye, k + 0.1)
  }
  if ((mood === 'live' || mood === 'core') && frame % 5 === 4) eye = main // blink
  const px: number[][] = TEMPLATE.map((row) => {
    const half = row.map((t) => (t === 1 ? main : t === 2 ? eye : r() > 0.55 ? (r() > 0.75 ? accent : main) : BG))
    return [...half, ...[...half].reverse()]
  })
  const words: number[] = []
  for (let y = 0; y < 8; y += 2) {
    const top = px[y] ?? []
    const bottom = px[y + 1] ?? []
    for (let x = 0; x < 8; x++) words.push(0x2580, top[x] ?? BG, bottom[x] ?? BG) // ▀ fg=top, bg=bottom
  }
  return words
}

/** Hex colour of the avatar's main hue, for text beside it (and the non-terminal fallback). */
export function avatarColor(seed: string, mood: AvatarMood): string {
  const h = hash(seed)
  const hue = mood === 'fail' ? 0 : mood === 'stop' ? 40 : mood === 'core' ? 190 : h % 360
  const base = hsl(hue, 0.85, 0.6)
  return toHex(mood === 'done' ? dimRgb(base, 0.6) : mood === 'idle' ? dimRgb(base, 0.8) : base)
}

const NAMES = ['NOVA', 'VEGA', 'ORION', 'LYRA', 'ATLAS', 'RHEA', 'ZENO', 'KAI', 'IRIS', 'HELIX', 'ECHO', 'PYX',
  'TALOS', 'SOL', 'NYX', 'AXIOM', 'QUILL', 'DRAKO', 'ION', 'MIRA', 'ONYX', 'RUNE', 'SAGE', 'VOLT']

export function callsign(seed: string): string {
  const h = hash(seed)
  return `${NAMES[h % NAMES.length]}-${(h >>> 8).toString(16).slice(0, 3).toUpperCase().padStart(3, '0')}`
}

// Theme keys the engine colours /context rows with → RGB for the Raster bar.
const THEME_RGB: Record<string, number> = {
  promptBorder: 0x94a3b8, inactive: 0x475569, permission: 0x818cf8, claude: 0xf97316, success: 0x4ade80,
  warning: 0xfbbf24, error: 0xf87171, remember: 0x60a5fa, suggestion: 0xa78bfa, planMode: 0x2dd4bf,
  autoAccept: 0xe879f9, ide: 0x38bdf8, bashBorder: 0xf472b6, merged: 0xc084fc, text: 0xe2e8f0, subtle: 0x64748b,
}
const FALLBACK = [0x22d3ee, 0xe879f9, 0xa3e635, 0xfbbf24, 0x818cf8, 0xf472b6, 0x2dd4bf]

export type ContextCat = { name: string; tokens: number; kind: string; color: string }

export function catRgb(c: ContextCat, i: number): number {
  if (c.kind === 'free') return 0x1e293b
  if (c.kind === 'buffer') return 0x713f12
  return THEME_RGB[c.color] ?? FALLBACK[i % FALLBACK.length] ?? 0x22d3ee
}

/** One row of `width` cells, each category a run of █ in its colour, proportional to tokens. */
export function contextBarWords(cats: readonly ContextCat[], width: number): number[] {
  const shown = cats.filter((c) => c.kind !== 'deferred' && c.tokens > 0)
  const total = shown.reduce((n, c) => n + c.tokens, 0)
  const words: number[] = []
  if (total <= 0) return Array.from({ length: width }, () => [0x2591, 0x334155, 0x01000000]).flat()
  let acc = 0
  let drawn = 0
  shown.forEach((c, i) => {
    acc += c.tokens
    const upto = i === shown.length - 1 ? width : Math.round((acc / total) * width)
    const rgb = catRgb(c, i)
    for (; drawn < upto; drawn++) words.push(0x2588, rgb, 0x01000000)
  })
  return words
}

/** Raster's `cells`: padded base64 of little-endian u32 words. */
export function encodeCells(words: readonly number[]): string {
  const bytes: number[] = []
  for (const w of words) bytes.push(w & 255, (w >>> 8) & 255, (w >>> 16) & 255, (w >>> 24) & 255)
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0, b1 = bytes[i + 1] ?? 0, b2 = bytes[i + 2] ?? 0
    const n = (b0 << 16) | (b1 << 8) | b2
    out += A[(n >> 18) & 63]! + A[(n >> 12) & 63]! + (i + 1 < bytes.length ? A[(n >> 6) & 63]! : '=') + (i + 2 < bytes.length ? A[n & 63]! : '=')
  }
  return out
}

/** Segmented gauge: ▰ lit, ▱ unlit. */
export function gauge(pct: number, width: number): string {
  const w = Math.max(4, Math.min(30, width))
  const lit = Math.max(0, Math.min(w, Math.round((pct / 100) * w)))
  return '▰'.repeat(lit) + '▱'.repeat(w - lit)
}

export function levelColor(pct: number): string {
  return pct >= 85 ? NEON.red : pct >= 60 ? NEON.amber : NEON.cyan
}

export function fmtReset(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const mins = Math.max(0, Math.round((t - now) / 60000))
  if (mins < 60) return `resets in ${mins}m`
  if (mins < 48 * 60) return `resets in ${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
  const d = new Date(t)
  return `resets ${d.toLocaleString('en', { weekday: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function windowLabel(kind: string): string {
  return kind === 'five_hour' ? '5h limit' : kind === 'seven_day' ? '7d limit' : kind === 'spend_limit' ? 'spend' : kind.replace(/_/g, ' ')
}

export const SPINNER = ['◐', '◓', '◑', '◒']
