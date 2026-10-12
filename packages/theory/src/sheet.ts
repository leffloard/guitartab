/**
 * Pasted chord sheets: "chords over lyrics" plain text and ChordPro (`[C]` inline chords,
 * `{title: ...}` directives). The parser keeps every line as written; the renderer swaps chord
 * names while keeping each chord in its column, so the chords still sit over the right
 * syllables.
 */
import { parseChordLabel, type ParsedLabel, type ProgressionInput } from './progression.ts'

export type SheetFormat = 'chords-over-lyrics' | 'chordpro'

export interface ChordToken {
  /** The chord as written, e.g. "F#m7". */
  text: string
  parsed: ParsedLabel
  /** Position in {@link ChordSheet.chords}, i.e. in the progression. */
  index: number
}

export interface Positioned<T> {
  /** Column in the (tab-expanded) line where the item starts. */
  column: number
  item: T
}

/** Non-chord marks allowed on a chord line: bars, repeats, labels like "Intro:". */
export interface Mark {
  text: string
}

export type SheetLine =
  | { kind: 'chords'; text: string; items: Positioned<ChordToken | Mark>[] }
  | { kind: 'inline'; text: string; lyrics: string; chords: Positioned<ChordToken>[] }
  | { kind: 'lyrics'; text: string }
  | { kind: 'section'; text: string }
  | { kind: 'tab'; text: string }
  | { kind: 'directive'; text: string; name: string; value: string }
  | { kind: 'blank'; text: string }

export interface ChordSheet {
  format: SheetFormat
  lines: SheetLine[]
  /** Every chord in reading order (no-chord markers included). */
  chords: ChordToken[]
  /** From ChordPro directives, when present. */
  meta: { title?: string; artist?: string; capo?: number; key?: string }
}

export function isChordToken(item: ChordToken | Mark): item is ChordToken {
  return 'parsed' in item
}

// ---------------------------------------------------------------------------------------------
// Line classification

const TAB_WIDTH = 8

/** Expands tabs to the next multiple of 8 so that columns line up as they look on screen. */
export function expandTabs(line: string): string {
  if (!line.includes('\t')) return line
  let out = ''
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(TAB_WIDTH - (out.length % TAB_WIDTH))
    else out += ch
  }
  return out
}

const SECTION_WORDS =
  'intro|verse|chorus|pre-?chorus|bridge|outro|solo|interlude|instrumental|refrain|coda|ending|' +
  'giriş|kıta|nakarat|köprü|ara|bölüm|final|çıkış'
/** "Verse 1", "[Chorus]", "Nakarat:", "(Solo x2)". */
const SECTION = new RegExp(
  `^\\s*[\\[(]?\\s*(?:${SECTION_WORDS})(?![\\p{L}])[\\s\\d.]*(?:x\\s?\\d+|\\d+\\s?x)?\\s*[\\])]?\\s*:?\\s*$`,
  'iu',
)
const BRACKETED_LINE = /^\s*\[[^\]]*\]\s*$/
const DIRECTIVE = /^\s*\{\s*([^}:\s]+)\s*(?::\s*([^}]*))?\}\s*$/
const TAB_LINE = /^\s*[eBGDAEbgda]\s*[|:]?[-0-9hpbrsx/\\|~().^]{5,}\s*$/
const BAR_OR_REPEAT =
  /^(?:\|+:?|:?\|+|%|\/+|-+|\.{2,}|→|\(?(?:x\s?\d+|\d+\s?x|repeat|tekrar)\)?|\*+)$/i
const LABEL = /^[\p{L}\d][\p{L}\d'-]*:$/u

function chordOf(text: string): ParsedLabel | null {
  const stripped = text.replace(/^\((.+)\)$/, '$1')
  const parsed = parseChordLabel(stripped)
  return parsed.kind === 'invalid' ? null : parsed
}

/** Splits a line into whitespace-separated tokens with their columns. */
function tokenize(line: string): { text: string; column: number }[] {
  const out: { text: string; column: number }[] = []
  for (const m of line.matchAll(/\S+/g)) out.push({ text: m[0], column: m.index })
  return out
}

/**
 * A line is a chord line when every token is a chord, a no-chord marker or a mark (bar,
 * repeat, a leading "Intro:" label), with at least one chord. One stray word is tolerated on
 * lines with four or more chords. This keeps lyrics such as "A man, a plan" or "Am I wrong"
 * out, at the price of missing chord lines that mix in prose.
 */
function classifyChordLine(line: string): {
  kind: 'chords'
  items: { column: number; text: string; parsed: ParsedLabel | null }[]
} | null {
  const tokens = tokenize(line)
  if (tokens.length === 0) return null
  let chords = 0
  let words = 0
  const items = tokens.map((t, i) => {
    const parsed = chordOf(t.text)
    if (parsed) {
      if (parsed.kind === 'chord') chords++
      return { ...t, parsed }
    }
    if (!BAR_OR_REPEAT.test(t.text) && !(i === 0 && LABEL.test(t.text))) words++
    return { ...t, parsed: null }
  })
  if (chords === 0) return null
  if (words === 0 || (words === 1 && chords >= 4)) return { kind: 'chords', items }
  return null
}

const INLINE_CHORD = /\[([^\]]+)\]/g

function looksLikeChordPro(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (DIRECTIVE.test(line)) return true
    for (const m of line.matchAll(INLINE_CHORD)) {
      const content = m[1] ?? ''
      if (SECTION.test(content)) continue
      if (chordOf(content) === null) continue
      // A bracketed chord inside or right before lyrics, not a lone "[Verse]"-style line.
      if (!BRACKETED_LINE.test(line) || line.replace(INLINE_CHORD, '').trim() !== '') return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------------------------
// Parsing

export function parseChordSheet(text: string): ChordSheet {
  const rawLines = text.replace(/\r\n?/g, '\n').split('\n').map(expandTabs)
  const format: SheetFormat = looksLikeChordPro(rawLines) ? 'chordpro' : 'chords-over-lyrics'
  const chords: ChordToken[] = []
  const meta: ChordSheet['meta'] = {}
  const token = (text: string, parsed: ParsedLabel): ChordToken => {
    const t = { text, parsed, index: chords.length }
    chords.push(t)
    return t
  }

  const lines: SheetLine[] = rawLines.map((line): SheetLine => {
    if (line.trim() === '') return { kind: 'blank', text: line }

    const directive = DIRECTIVE.exec(line)
    if (directive) {
      const name = (directive[1] ?? '').toLowerCase()
      const value = (directive[2] ?? '').trim()
      if (name === 'title' || name === 't') meta.title = value
      if (name === 'artist' || name === 'subtitle' || name === 'st') meta.artist ??= value
      if (name === 'key') meta.key = value
      if (name === 'capo' && /^\d+$/.test(value)) meta.capo = Number(value)
      return { kind: 'directive', text: line, name, value }
    }
    if (TAB_LINE.test(line)) return { kind: 'tab', text: line }

    if (format === 'chordpro' && /\[[^\]]+\]/.test(line)) {
      let lyrics = ''
      let last = 0
      const placed: Positioned<ChordToken>[] = []
      for (const m of line.matchAll(INLINE_CHORD)) {
        lyrics += line.slice(last, m.index)
        last = m.index + m[0].length
        const parsed = chordOf(m[1] ?? '')
        if (parsed) placed.push({ column: lyrics.length, item: token(m[1] ?? '', parsed) })
        else lyrics += m[0] // e.g. "[Verse]" kept as text
      }
      lyrics += line.slice(last)
      if (placed.length > 0) return { kind: 'inline', text: line, lyrics, chords: placed }
    }

    // Chord lines first: "Intro: Am G" is a chord line, not a section heading.
    const chordLine = classifyChordLine(line)
    if (chordLine) {
      const items = chordLine.items.map(({ column, text, parsed }) => ({
        column,
        item: parsed ? token(text.replace(/^\((.+)\)$/, '$1'), parsed) : { text },
      }))
      return { kind: 'chords', text: line, items }
    }
    if (SECTION.test(line) || BRACKETED_LINE.test(line)) return { kind: 'section', text: line }
    return { kind: 'lyrics', text: line }
  })
  return { format, lines, chords, meta }
}

/** The sheet's chords as engine input, in reading order. */
export function sheetProgression(sheet: ChordSheet): ProgressionInput[] {
  return sheet.chords.map((c) => ({ label: c.text }))
}

// ---------------------------------------------------------------------------------------------
// Rendering

/** A chord placed in a rendered line, for highlighting and click handling. */
export interface RenderedChord {
  start: number
  end: number
  token: ChordToken
}

export interface RenderedLine {
  kind: 'chords' | 'lyrics' | 'section' | 'tab' | 'directive' | 'blank'
  text: string
  chords: RenderedChord[]
}

/** Replacement text for a chord token; return the token's text to keep it. */
export type ChordReplacer = (token: ChordToken) => string

/**
 * Places items at their columns. An item never starts before its original column; if a longer
 * replacement reaches the next item, that item moves right just enough to keep one space.
 */
function placeColumns(items: readonly Positioned<{ text: string; token?: ChordToken }>[]): {
  text: string
  chords: RenderedChord[]
} {
  let text = ''
  const chords: RenderedChord[] = []
  for (const { column, item } of items) {
    const start = Math.max(column, text.length === 0 ? 0 : text.length + 1)
    text = text.padEnd(start, ' ') + item.text
    if (item.token) chords.push({ start, end: start + item.text.length, token: item.token })
  }
  return { text, chords }
}

/**
 * Renders the sheet with replaced chord names. Chords-over-lyrics lines keep their columns;
 * ChordPro inline lines are shown as a chord line over the lyric line. Lyrics are never
 * changed. With an identity replacer, every line renders exactly as written.
 */
export function renderChordSheet(sheet: ChordSheet, replace: ChordReplacer): RenderedLine[] {
  const out: RenderedLine[] = []
  for (const line of sheet.lines) {
    switch (line.kind) {
      case 'chords': {
        const items = line.items.map(({ column, item }) =>
          isChordToken(item)
            ? { column, item: { text: replace(item), token: item } }
            : { column, item: { text: item.text } },
        )
        const unchanged = line.items.every(
          ({ item }) => !isChordToken(item) || replace(item) === item.text,
        )
        const placed = placeColumns(items)
        // Keep the original text (indentation, trailing spaces, odd parentheses) when nothing changed.
        out.push({
          kind: 'chords',
          text: unchanged ? line.text : placed.text,
          chords: placed.chords,
        })
        break
      }
      case 'inline': {
        const placed = placeColumns(
          line.chords.map(({ column, item }) => ({
            column,
            item: { text: replace(item), token: item },
          })),
        )
        out.push({ kind: 'chords', text: placed.text, chords: placed.chords })
        if (line.lyrics.trim() !== '') out.push({ kind: 'lyrics', text: line.lyrics, chords: [] })
        break
      }
      default:
        out.push({ kind: line.kind, text: line.text, chords: [] })
    }
  }
  return out
}

/** Plain-text rendering (for copying or printing). */
export function renderedToText(lines: readonly RenderedLine[]): string {
  return lines.map((l) => l.text.replace(/\s+$/, '')).join('\n')
}

/**
 * ChordPro rendering: chords inlined into the lyric line that follows a chord line, a
 * `{capo: n}` directive when a capo is used. Chord lines without lyrics stay chord-only lines
 * of bracketed chords.
 */
export function toChordPro(
  sheet: ChordSheet,
  replace: ChordReplacer,
  options: { capo?: number; title?: string } = {},
): string {
  const out: string[] = []
  const title = options.title ?? sheet.meta.title
  if (title) out.push(`{title: ${title}}`)
  if (options.capo) out.push(`{capo: ${options.capo}}`)
  const rendered = renderChordSheet(
    {
      ...sheet,
      lines: sheet.lines.filter(
        (l) => !(l.kind === 'directive' && ['title', 't', 'capo'].includes(l.name)),
      ),
    },
    replace,
  )
  for (let i = 0; i < rendered.length; i++) {
    const line = rendered[i]
    if (!line) continue
    const next = rendered[i + 1]
    if (line.kind === 'chords' && next?.kind === 'lyrics') {
      let lyric = next.text
      // Insert from the right so earlier positions stay valid.
      for (const c of [...line.chords].reverse()) {
        const at = Math.min(c.start, lyric.length)
        lyric = lyric.padEnd(at, ' ')
        lyric = `${lyric.slice(0, at)}[${line.text.slice(c.start, c.end)}]${lyric.slice(at)}`
      }
      out.push(lyric)
      i++
    } else if (line.kind === 'chords') {
      out.push(line.chords.map((c) => `[${line.text.slice(c.start, c.end)}]`).join(' '))
    } else if (line.kind === 'section') {
      out.push(`{comment: ${line.text.trim().replace(/^\[|\]$/g, '')}}`)
    } else out.push(line.text)
  }
  return out.join('\n').replace(/\s+$/, '') + '\n'
}
