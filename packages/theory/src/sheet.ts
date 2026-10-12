/**
 * Pasted chord sheets: "chords over lyrics" plain text and ChordPro (`[C]` inline chords,
 * `{title: ...}` directives). The parser keeps every line as written; the renderer swaps chord
 * names while keeping each chord in its column, so the chords still sit over the right
 * syllables.
 */
import { parseChordLabel, type ParsedLabel, type ProgressionInput } from './progression.ts'

export type SheetFormat = 'chords-over-lyrics' | 'chordpro'

export interface ChordToken {
  /** The chord as written, without wrapping punctuation, e.g. "F#m7" for "(F#m7)". */
  text: string
  parsed: ParsedLabel
  /** Position in {@link ChordSheet.chords}, i.e. in the progression. */
  index: number
}

export interface Positioned<T> {
  /** Column in the (tab-expanded) line, or in the lyrics of a ChordPro line, where it starts. */
  column: number
  item: T
  /** Written right after the previous item with no space in between, as in "|F" or "(F)". */
  attached?: true
}

/**
 * Non-chord text on a chord line: bars, repeats, wrapping parentheses, a leading "Intro:"
 * label. In ChordPro, an `[*annotation]`.
 */
export interface Mark {
  text: string
}

/** Plain-text header fields that sheets often carry ("Key: F", "Capo 2", "Tuning: ..."). */
export type MetaName = 'key' | 'capo' | 'tempo' | 'tuning'

export type SheetLine =
  | { kind: 'chords'; text: string; items: Positioned<ChordToken | Mark>[] }
  | { kind: 'inline'; text: string; lyrics: string; items: Positioned<ChordToken | Mark>[] }
  | { kind: 'lyrics'; text: string }
  | { kind: 'section'; text: string }
  | { kind: 'tab'; text: string }
  | { kind: 'directive'; text: string; name: string; value: string }
  | { kind: 'meta'; text: string; name: MetaName; value: string }
  | { kind: 'blank'; text: string }

export interface ChordSheet {
  format: SheetFormat
  lines: SheetLine[]
  /** Every chord in reading order (no-chord markers included). */
  chords: ChordToken[]
  /** From ChordPro directives or plain header lines, when present. */
  meta: { title?: string; artist?: string; capo?: number; key?: string }
}

export function isChordToken(item: ChordToken | Mark): item is ChordToken {
  return 'parsed' in item
}

/**
 * A line that sets the capo the chords were written for (`{capo: 2}`, "Capo: 2"). Apps that
 * work out their own capo hide these lines, since the source capo is folded into the chords.
 */
export function isCapoLine(line: SheetLine): boolean {
  return (line.kind === 'directive' || line.kind === 'meta') && line.name === 'capo'
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

/** Section names in English and Turkish, as regex alternatives (lower case). */
const SECTION_WORDS = [
  'intro',
  'verse',
  'pre[-\\s]?chorus',
  'post[-\\s]?chorus',
  'chorus',
  'bridge',
  'outro',
  'solo',
  'interlude',
  'instrumental',
  'refrain',
  'coda',
  'ending',
  'break',
  'riff',
  'giriş',
  'kıta',
  'ön\\s+nakarat',
  'nakarat',
  'köprü',
  'ara(?:\\s+nağme(?:si)?)?',
  'bölüm',
  'final',
  'çıkış',
  'tekrar',
  'enstrümantal',
].join('|')
/** "x2", "2x", "2 kez" (Turkish "2 times"). */
const REPEAT = '(?:[x×]\\s?\\d+|\\d+\\s?[x×]|\\d+\\s*(?:kez|kere|times))'
/** "1." or "2)" before a section name. */
const ORDINAL = '(?:\\d+\\s*[.)]\\s*)'

/** A whole-line heading: "Verse 1", "[Chorus] x2", "Nakarat:", "(Solo x2)", "1. Kıta". */
const SECTION = new RegExp(
  `^\\s*${ORDINAL}?[\\[(]?\\s*${ORDINAL}?(?:${SECTION_WORDS})(?![\\p{L}])[\\s\\d.]*${REPEAT}?` +
    `\\s*[\\])]?\\s*(?:[\\[(]?\\s*${REPEAT}\\s*[\\])]?)?\\s*:?\\s*$`,
  'iu',
)
/** A section label that starts a chord line, with a colon: "Solo Gitar:", "Verse 1:", "Intro:F". */
const LEADING_LABEL_COLON = new RegExp(
  `^(\\s*)(${ORDINAL}?(?:${SECTION_WORDS})(?![\\p{L}])[^:]{0,20}:)(?=\\s|$|[A-G(|])`,
  'iu',
)
/** ... or without one: "Intro F Bm", "Verse 2 Am G", "Giriş - F". */
const LEADING_LABEL_WORD = new RegExp(
  `^(\\s*)(${ORDINAL}?(?:${SECTION_WORDS})(?![\\p{L}])(?:[ \\t]+\\d+)?)(?=\\s|$)`,
  'iu',
)
const LEADING_BRACKETS = /^(\s*)(\[[^\]]*\]|\([^)]*\)):?/

/**
 * JavaScript's case-insensitive matching does not map İ to i or I to ı, so all-caps Turkish
 * ("GİRİŞ", "KITA") is also tried in Turkish lower case. That mapping keeps the length.
 */
function turkishLower(text: string): string | null {
  const lower = text.toLocaleLowerCase('tr')
  return lower !== text && lower.length === text.length ? lower : null
}

function isSectionHeading(text: string): boolean {
  if (SECTION.test(text)) return true
  const lower = turkishLower(text)
  return lower !== null && SECTION.test(lower)
}

const BRACKETED_LINE = /^\s*\[[^\]]*\]\s*$/
const DIRECTIVE = /^\s*\{\s*([^}:\s]+)\s*(?::\s*([^}]*))?\}\s*$/
const TAB_LINE = /^\s*[eBGDAEbgda]\s*[|:]?[-0-9hpbrsx/\\|~().^]{5,}\s*$/
/** Marks that may stand between chords: bars, beat slashes and dots, repeats, counts. */
const BAR_OR_REPEAT = new RegExp(
  `^(?:\\|+:?|:?\\|+|%|\\/+|-+|\\.+|→|~+|\\*+|\\d+|${REPEAT}|repeat|tekrar)$`,
  'iu',
)
const LABEL = /^[\p{L}\d][\p{L}\d'-]*:$/u

const META_NAMES: Readonly<Record<string, MetaName>> = {
  key: 'key',
  tonality: 'key',
  ton: 'key',
  tonalite: 'key',
  tonalité: 'key',
  capo: 'capo',
  kapo: 'capo',
  tempo: 'tempo',
  bpm: 'tempo',
  tuning: 'tuning',
  akort: 'tuning',
  düzen: 'tuning',
}
const META_LINE = /^\s*(\p{L}+)\s*(?:[:=]\s*(.*?)|\s+(\d.*?))\s*$/u

/** "2", "2nd fret", "on 3rd fret", "2. perde"; null for "none", "yok", "no capo"... */
function capoNumber(value: string): number | null {
  const m = /^(?:on\s+)?(\d{1,2})\s*(?:st|nd|rd|th|\.)?(?:\s*(?:fret|perde\p{L}*))?$/iu.exec(
    value.trim(),
  )
  const n = m ? Number(m[1]) : NaN
  return Number.isInteger(n) && n <= 12 ? n : null
}

/** A plain-text header line such as "Key: F", "Ton: Am", "Capo 2", "Tuning: E A D G B E". */
function metaOf(line: string): { name: MetaName; value: string } | null {
  const m = META_LINE.exec(line)
  const word = m?.[1]
  if (!m || word === undefined) return null
  const name = META_NAMES[word.toLocaleLowerCase('tr')] ?? META_NAMES[word.toLowerCase()]
  if (!name) return null
  if (m[2] !== undefined) return { name, value: m[2] }
  // "Capo 2" without a colon counts only for the capo, and only with a fret number.
  const value = m[3] ?? ''
  return name === 'capo' && capoNumber(value) !== null ? { name, value } : null
}

/**
 * Splits wrapping punctuation off a token: "(F)" → "(", "F", ")"; "Am," → "Am", ",".
 * Parentheses that belong to the chord ("C(add9)") stay.
 */
function peel(text: string): string[] {
  const prefix = /^\(+/.exec(text)?.[0] ?? ''
  let core = text.slice(prefix.length)
  let suffix = ''
  const count = (s: string, ch: string) => s.split(ch).length - 1
  for (;;) {
    const last = core.at(-1)
    const strip =
      last === ',' || last === ';' || (last === ')' && count(core, '(') < count(core, ')'))
    if (!strip) break
    suffix = last + suffix
    core = core.slice(0, -1)
  }
  if (core === '') return [text]
  return [prefix, core, suffix].filter((s) => s !== '')
}

/** Wrapping punctuation split off by {@link peel}. */
const WRAPPER = /^[(),;]+$/

function chordOf(text: string): ParsedLabel | null {
  const core = peel(text).find((p) => !WRAPPER.test(p)) ?? text
  const parsed = parseChordLabel(core)
  return parsed.kind === 'invalid' ? null : parsed
}

/** The section label at the start of a chord line, if any. */
function leadingLabel(line: string): { column: number; text: string } | null {
  const bracket = LEADING_BRACKETS.exec(line)
  if (bracket) {
    const [, indent = '', span = ''] = bracket
    // In a plain sheet, a square-bracketed span is a label ("[Verse 1]", "[A]"); a
    // parenthesized one only if it names a section ("(Intro)", not "(Am)").
    if (span.startsWith('[') || isSectionHeading(span.slice(1, -1)))
      return { column: indent.length, text: bracket[0].slice(indent.length) }
    return null
  }
  const lower = turkishLower(line)
  for (const re of [LEADING_LABEL_COLON, LEADING_LABEL_WORD]) {
    const m = re.exec(line) ?? (lower === null ? null : re.exec(lower))
    if (m) {
      const indent = m[1] ?? ''
      // Slice the original: the Turkish lower-case form has the same length.
      return { column: indent.length, text: line.slice(indent.length, m[0].length) }
    }
  }
  return null
}

/** Bars, bracketed repeats ("(x2)", "[2 kez]") and other runs of non-space characters. */
const ATOM = new RegExp(`[\\[(]\\s*(?:${REPEAT}|repeat|tekrar)\\s*[\\])]|:?\\|+:?|[^\\s|]+`, 'giu')

interface RawItem {
  column: number
  text: string
  parsed: ParsedLabel | null
  attached: boolean
}

/**
 * A line is a chord line when every token is a chord, a no-chord marker or a mark (bar,
 * repeat, wrapping parenthesis, a leading section label), with at least one chord. One stray
 * word is tolerated on lines with four or more chords. This keeps lyrics such as "A man, a
 * plan" or "Am I wrong" out, at the price of missing chord lines that mix in prose.
 */
function classifyChordLine(line: string): RawItem[] | null {
  const items: RawItem[] = []
  const label = leadingLabel(line)
  let end = -1
  const push = (column: number, text: string, parsed: ParsedLabel | null) => {
    items.push({ column, text, parsed, attached: column === end })
    end = column + text.length
  }
  if (label) push(label.column, label.text, null)

  let chords = 0
  let words = 0
  const from = label ? label.column + label.text.length : 0
  for (const m of line.slice(from).matchAll(ATOM)) {
    let column = from + m.index
    const pieces = /^:?\|+:?$/.test(m[0]) ? [m[0]] : peel(m[0])
    for (const piece of pieces) {
      const parsed = parseChordLabel(piece)
      if (parsed.kind !== 'invalid') {
        if (parsed.kind === 'chord') chords++
        push(column, piece, parsed)
      } else {
        const wrapper = pieces.length > 1 && WRAPPER.test(piece)
        const firstLabel = items.length === 0 && LABEL.test(piece)
        if (!wrapper && !firstLabel && !BAR_OR_REPEAT.test(piece) && !isBracketedRepeat(piece))
          words++
        push(column, piece, null)
      }
      column += piece.length
    }
  }
  if (chords === 0) return null
  return words === 0 || (words === 1 && chords >= 4) ? items : null
}

function isBracketedRepeat(text: string): boolean {
  return /^[[(]/.test(text) && text.length > 2 && BAR_OR_REPEAT.test(text.slice(1, -1).trim())
}

const INLINE_CHORD = /\[([^\]]+)\]/g

function looksLikeChordPro(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (DIRECTIVE.test(line)) return true
    for (const m of line.matchAll(INLINE_CHORD)) {
      const content = m[1] ?? ''
      if (isSectionHeading(content)) continue
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
  const setCapo = (value: string) => {
    const capo = capoNumber(value)
    if (capo !== null) meta.capo ??= capo
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
      if (name === 'capo') setCapo(value)
      return { kind: 'directive', text: line, name, value }
    }
    if (TAB_LINE.test(line)) return { kind: 'tab', text: line }

    if (format === 'chordpro' && /\[[^\]]+\]/.test(line)) {
      const inline = parseInline(line, token)
      if (inline) return inline
    }

    // Header fields before chord lines: "Key: F" or "Tuning: E A D G B E" are not chords.
    const field = metaOf(line)
    if (field) {
      if (field.name === 'key') meta.key ??= field.value
      if (field.name === 'capo') setCapo(field.value)
      return { kind: 'meta', text: line, ...field }
    }

    // Chord lines before sections: "Intro: Am G" is a chord line, not a section heading.
    const items = classifyChordLine(line)
    if (items) {
      return {
        kind: 'chords',
        text: line,
        items: items.map(({ column, text, parsed, attached }) => ({
          column,
          item: parsed ? token(text, parsed) : { text },
          ...(attached ? { attached: true as const } : {}),
        })),
      }
    }
    if (isSectionHeading(line) || BRACKETED_LINE.test(line)) return { kind: 'section', text: line }
    return { kind: 'lyrics', text: line }
  })
  return { format, lines, chords, meta }
}

/** A ChordPro line with inline chords; null when none of its brackets holds a chord. */
function parseInline(
  line: string,
  token: (text: string, parsed: ParsedLabel) => ChordToken,
): SheetLine | null {
  // Parse first, create tokens only once the line is known to hold a chord.
  const found: { column: number; pieces: string[]; annotation: boolean }[] = []
  let lyrics = ''
  let last = 0
  for (const m of line.matchAll(INLINE_CHORD)) {
    lyrics += line.slice(last, m.index)
    last = m.index + m[0].length
    const content = m[1] ?? ''
    if (content.startsWith('*')) {
      found.push({ column: lyrics.length, pieces: [content.slice(1)], annotation: true })
    } else if (chordOf(content)) {
      found.push({ column: lyrics.length, pieces: peel(content), annotation: false })
    } else lyrics += m[0] // e.g. "[Verse]" kept as text
  }
  lyrics += line.slice(last)
  if (!found.some((f) => !f.annotation)) return null

  const items: Positioned<ChordToken | Mark>[] = []
  for (const { column, pieces, annotation } of found) {
    pieces.forEach((text, i) => {
      const parsed = annotation || WRAPPER.test(text) ? null : chordOf(text)
      const item = parsed ? token(text, parsed) : { text }
      items.push({ column, item, ...(i > 0 ? { attached: true as const } : {}) })
    })
  }
  return { kind: 'inline', text: line, lyrics, items }
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
  kind: 'chords' | 'lyrics' | 'section' | 'tab' | 'directive' | 'meta' | 'blank'
  text: string
  chords: RenderedChord[]
}

/** Replacement text for a chord token; return the token's text to keep it. */
export type ChordReplacer = (token: ChordToken) => string

/**
 * Places items at their columns. An item never starts before its original column; if a longer
 * replacement reaches the next item, that item moves right just enough to keep one space.
 * Attached items ("|F", "(F)") stay attached.
 */
function placeColumns(
  items: readonly Positioned<ChordToken | Mark>[],
  replace: ChordReplacer,
): { text: string; chords: RenderedChord[] } {
  let text = ''
  const chords: RenderedChord[] = []
  for (const { column, item, attached } of items) {
    const name = isChordToken(item) ? replace(item) : item.text
    const start =
      attached && text.length > 0
        ? text.length
        : Math.max(column, text.length === 0 ? 0 : text.length + 1)
    text = text.padEnd(start, ' ') + name
    if (isChordToken(item)) chords.push({ start, end: start + name.length, token: item })
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
        const placed = placeColumns(line.items, replace)
        const unchanged = line.items.every(
          ({ item }) => !isChordToken(item) || replace(item) === item.text,
        )
        // Unchanged lines keep their exact text (trailing spaces); the chord spans are the same.
        out.push({
          kind: 'chords',
          text: unchanged ? line.text : placed.text,
          chords: placed.chords,
        })
        break
      }
      case 'inline': {
        const placed = placeColumns(line.items, replace)
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

/** Marks that only make sense in a monospace layout: bars, dots, slashes, lone brackets. */
const LAYOUT_MARK = /^[|:%/\\.\-–—→~*(),;[\]]+$/

interface ChordProPiece {
  column: number
  text: string
  attached: boolean
  kind: 'chord' | 'layout' | 'text'
}

/** Chord-line items as ChordPro pieces. A chord in parentheses stays one chord: "[(Fmaj7)]". */
function chordProPieces(
  items: readonly Positioned<ChordToken | Mark>[],
  replace: ChordReplacer,
): ChordProPiece[] {
  const out: ChordProPiece[] = []
  const markIs = (p: Positioned<ChordToken | Mark> | undefined, text: string) =>
    p !== undefined && p.attached === true && !isChordToken(p.item) && p.item.text === text
  for (let k = 0; k < items.length; k++) {
    const p = items[k]
    if (!p) continue
    const next = items[k + 1]
    const attached = p.attached === true
    if (
      !isChordToken(p.item) &&
      p.item.text === '(' &&
      next &&
      isChordToken(next.item) &&
      next.attached &&
      markIs(items[k + 2], ')')
    ) {
      out.push({ column: p.column, text: `[(${replace(next.item)})]`, attached, kind: 'chord' })
      k += 2
    } else if (isChordToken(p.item)) {
      out.push({ column: p.column, text: `[${replace(p.item)}]`, attached, kind: 'chord' })
    } else {
      const kind = LAYOUT_MARK.test(p.item.text) ? 'layout' : 'text'
      out.push({ column: p.column, text: p.item.text, attached, kind })
    }
  }
  return out
}

/**
 * Inlines chords into a lyric at their original columns (padding the lyric when a chord lies
 * past its end). Labels and repeats become `[*annotations]`; bars and other layout marks are
 * dropped, since inline chords carry no column layout.
 */
function inlineInto(lyric: string, pieces: readonly ChordProPiece[]): string {
  let out = lyric
  // From the right, so the columns of the pieces still to insert stay valid.
  for (const p of [...pieces].reverse()) {
    if (p.kind === 'layout') continue
    const text = p.kind === 'chord' ? p.text : `[*${p.text}]`
    out = out.padEnd(p.column, ' ')
    out = out.slice(0, p.column) + text + out.slice(p.column)
  }
  return out
}

/** A chord line without lyrics: chords in brackets, marks kept as text ("Intro: [Am] (x2)"). */
function chordOnlyLine(pieces: readonly ChordProPiece[]): string {
  return pieces.map((p, i) => (i === 0 || p.attached ? '' : ' ') + p.text).join('')
}

/**
 * ChordPro rendering: chords inlined into the lyric line that follows a chord line, at the
 * columns they were written at, and a `{capo: n}` directive when a capo is used. The source's
 * own capo lines are dropped (the caller passes the capo the chords are now written for).
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
  const lines = sheet.lines.filter(
    (l) => !isCapoLine(l) && !(l.kind === 'directive' && (l.name === 'title' || l.name === 't')),
  )
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line) continue
    switch (line.kind) {
      case 'chords': {
        const pieces = chordProPieces(line.items, replace)
        const next = lines[i + 1]
        if (next?.kind === 'lyrics') {
          out.push(inlineInto(next.text, pieces))
          i++
        } else out.push(chordOnlyLine(pieces))
        break
      }
      case 'inline':
        out.push(inlineInto(line.lyrics, chordProPieces(line.items, replace)))
        break
      case 'section':
        out.push(`{comment: ${line.text.trim().replace(/^\[|\]$/g, '')}}`)
        break
      case 'meta':
        out.push(`{comment: ${line.text.trim()}}`)
        break
      default:
        out.push(line.text)
    }
  }
  return out.join('\n').replace(/\s+$/, '') + '\n'
}
