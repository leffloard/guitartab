/**
 * Common chord-symbol notation as found in chord sheets: `F#m7b5`, `Bb/D`, `Gsus4`, `C6/9`,
 * `Am(maj7)`, `E7#9`, `Cadd9`, `D2`, `G5`, `C°7`, `Cø`, `C+`.
 */
import { describe, makeChord, type Chord, type IntervalMask, type Tension } from './chord.ts'
import { degreeToSemitones, intervalName } from './intervals.ts'
import { mod12, parseNote, parseNoteAt, spellPitchClass, type Spelling } from './pitch.ts'

export interface SymbolParseError {
  message: string
  /** Index in the input where parsing failed. */
  at: number
}

export type SymbolParseResult = { ok: true; chord: Chord } | { ok: false; error: SymbolParseError }

interface Tokens {
  minor: boolean
  majorSeventh: boolean
  /** Chord family number: 7, 9, 11 or 13 (null = triad). */
  family: number | null
  sixth: boolean
  dim: boolean
  dim7: boolean
  halfDim: boolean
  aug: boolean
  power: boolean
  sus: Set<2 | 4>
  fifth: 'b5' | '#5' | null
  /** Intervals (mod 12) added through `add`, alterations or parenthesized tensions. */
  added: Set<number>
  omit3: boolean
  omit5: boolean
}

type TokenRule = (rest: string, t: Tokens) => number

/** Each rule returns how many characters it consumed (0 = no match). */
const RULES: readonly TokenRule[] = [
  // separators
  (rest) => (/^[\s(),]/.test(rest) ? 1 : 0),
  // 6/9, 69
  (rest, t) => {
    const m = /^(6\/9|69)/.exec(rest)
    if (!m) return 0
    t.sixth = true
    t.added.add(2)
    return m[0].length
  },
  // no3 / omit5
  (rest, t) => {
    const m = /^(?:no|omit)\s?([35])(?:rd|th)?/.exec(rest)
    if (!m) return 0
    if (m[1] === '3') t.omit3 = true
    else t.omit5 = true
    return m[0].length
  },
  // add9, add#11, addb7 ...
  (rest, t) => {
    const m = /^add([b#♭♯]?\d{1,2})/.exec(rest)
    if (!m) return 0
    const semis = degreeToSemitones(m[1] ?? '')
    if (semis === null) return 0
    t.added.add(mod12(semis))
    return m[0].length
  },
  // major seventh family: maj7, M9, Δ, ma13 (a bare "maj" is just a major triad)
  (rest, t) => {
    const m = /^(?:maj|Maj|MAJ|ma(?!dd)|M|Δ|△)(13|11|9|7)?/.exec(rest)
    if (!m) return 0
    const n = m[1] ? Number(m[1]) : rest.startsWith('Δ') || rest.startsWith('△') ? 7 : null
    if (n !== null) {
      t.majorSeventh = true
      t.family = Math.max(t.family ?? 0, n)
    }
    return m[0].length
  },
  // diminished: dim, dim7, °, °7, o7
  (rest, t) => {
    const m = /^(?:dim|°|o)(7)?/.exec(rest)
    if (!m) return 0
    t.dim = true
    if (m[1]) t.dim7 = true
    return m[0].length
  },
  // half-diminished: ø, ø7
  (rest, t) => {
    const m = /^[øØ](7)?/.exec(rest)
    if (!m) return 0
    t.halfDim = true
    return m[0].length
  },
  // augmented: aug, + (but "+5"/"+9"/"+11" are alterations)
  (rest, t) => {
    const m = /^(?:aug|\+(?!(?:5|9|11)(?!\d)))/.exec(rest)
    if (!m) return 0
    t.aug = true
    return m[0].length
  },
  // sus, sus2, sus4
  (rest, t) => {
    const m = /^sus([24])?/.exec(rest)
    if (!m) return 0
    t.sus.add(m[1] === '2' ? 2 : 4)
    return m[0].length
  },
  // alterations: b5 #5 b9 #9 #11 b13 (also with +/-), only after a quality or number
  (rest, t) => {
    const m = /^([b#♭♯+-])(13|11|9|5)(?!\d)/.exec(rest)
    if (!m) return 0
    const sign = m[1] === '#' || m[1] === '♯' || m[1] === '+' ? 1 : -1
    const num = Number(m[2])
    if (m[1] === '-' && !(t.minor || t.family !== null || t.sixth || t.dim || t.aug)) return 0
    if (num === 5) {
      t.fifth = sign > 0 ? '#5' : 'b5'
      return m[0].length
    }
    if (num === 11 && sign < 0) return 0 // b11 is not a thing
    t.added.add(mod12((degreeToSemitones(String(num)) ?? 0) + sign))
    return m[0].length
  },
  // minor: m, min, mi, -
  (rest, t) => {
    const m = /^(?:min|mi|m|-)/.exec(rest)
    if (!m) return 0
    t.minor = true
    return m[0].length
  },
  // numbers: 13 11 9 7 6 5 4 2
  (rest, t) => {
    const m = /^(13|11|9|7|6|5|4|2)/.exec(rest)
    if (!m) return 0
    const n = Number(m[1])
    if (n === 6) t.sixth = true
    else if (n === 5) t.power = true
    else if (n === 2 || n === 4) t.sus.add(n)
    else if (n === 7 && t.dim) t.dim7 = true
    else if (t.family === null || t.family < 7) t.family = n
    else {
      // A natural tension after the family number: C7(9), C7(13), C9(13)
      t.added.add(mod12(degreeToSemitones(String(n)) ?? 0))
    }
    return m[0].length
  },
]

function emptyTokens(): Tokens {
  return {
    minor: false,
    majorSeventh: false,
    family: null,
    sixth: false,
    dim: false,
    dim7: false,
    halfDim: false,
    aug: false,
    power: false,
    sus: new Set(),
    fifth: null,
    added: new Set(),
    omit3: false,
    omit5: false,
  }
}

function tokensToMask(t: Tokens): IntervalMask {
  const set = new Set<number>([0])
  // third
  if (t.power) {
    // root + fifth only, unless other tokens add more
  } else if (t.sus.size > 0) {
    for (const s of t.sus) set.add(s === 2 ? 2 : 5)
  } else if (t.minor || t.dim || t.dim7 || t.halfDim) set.add(3)
  else set.add(4)
  // fifth
  if (t.fifth === 'b5' || t.dim || t.dim7 || t.halfDim) set.add(6)
  else if (t.fifth === '#5' || t.aug) set.add(8)
  else set.add(7)
  // seventh
  if (t.dim7) set.add(9)
  else if (t.halfDim) set.add(10)
  else if (t.family !== null && t.family >= 7) set.add(t.majorSeventh ? 11 : 10)
  // sixth
  if (t.sixth) set.add(9)
  // implied natural tensions of the family number, unless an altered version is present
  const added = t.added
  const altered9 = added.has(1) || added.has(3)
  const altered11 = added.has(6)
  if (t.family === 9 || t.family === 11 || t.family === 13) {
    if (!altered9) set.add(2)
  }
  if (t.family === 11 && !altered11) set.add(5)
  if (t.family === 13) set.add(9)
  for (const a of added) set.add(a)
  if (t.omit3) {
    set.delete(3)
    set.delete(4)
  }
  if (t.omit5) {
    set.delete(6)
    set.delete(7)
    set.delete(8)
  }
  let mask = 0
  for (const i of set) mask |= 1 << i
  return mask
}

function findBass(input: string): { body: string; bass: number | null } {
  // The bass is the text after the last '/' when it is a note name ("C6/9" has no bass).
  const slash = input.lastIndexOf('/')
  if (slash > 0) {
    const bass = parseNote(input.slice(slash + 1))
    if (bass !== null) return { body: input.slice(0, slash), bass }
  }
  return { body: input, bass: null }
}

/** Parses a chord symbol. Whitespace around the symbol is ignored. */
export function parseChordSymbol(input: string): SymbolParseResult {
  const text = input.trim()
  const { body, bass } = findBass(text)
  const root = parseNoteAt(body)
  if (!root) return { ok: false, error: { message: 'expected a root note A–G', at: 0 } }
  const tokens = emptyTokens()
  let pos = root.length
  while (pos < body.length) {
    const rest = body.slice(pos)
    let consumed = 0
    for (const rule of RULES) {
      consumed = rule(rest, tokens)
      if (consumed > 0) break
    }
    if (consumed === 0) {
      return { ok: false, error: { message: `unexpected "${rest}"`, at: pos } }
    }
    pos += consumed
  }
  return { ok: true, chord: makeChord(root.pc, tokensToMask(tokens), bass) }
}

/** Like {@link parseChordSymbol} but returns null on failure. */
export function tryParseChordSymbol(input: string): Chord | null {
  const result = parseChordSymbol(input)
  return result.ok ? result.chord : null
}

// ---------------------------------------------------------------------------------------------
// Formatting

export interface FormatOptions {
  spelling?: Spelling
}

const ALTERATIONS: ReadonlySet<Tension> = new Set(['b9', '#9', '#11', 'b13'])

/** Formats the chord suffix (everything after the root, without the slash bass). */
export function formatSuffix(chord: Chord): string {
  const s = describe(chord)
  const only = (mask: IntervalMask) => chord.intervals === mask
  if (only(0b10000001)) return '5'

  let quality = ''
  let numberPart = ''
  let sus = ''
  const alterations: string[] = []
  const adds: string[] = []
  const omits: string[] = []
  const tensions = new Set(s.tensions)

  const dimTriad = s.third === 'm3' && s.fifth === 'b5'
  if (dimTriad && s.seventh === 'bb7') quality = 'dim7'
  else if (dimTriad && s.seventh === null && !s.sixth) quality = 'dim'
  else if (s.third === 'M3' && s.fifth === '#5' && s.seventh === null && !s.sixth) quality = 'aug'
  else if (s.third === 'm3') quality = 'm'

  const fifthConsumed = quality === 'dim' || quality === 'dim7' || quality === 'aug'

  if (s.seventh === '7' || s.seventh === 'b7') {
    // The parser lets an altered 9 / 11 replace the natural one implied by 9, 11 and 13 chords,
    // so the natural tension may only be folded into the number when no altered one is present.
    let n = 7
    const natural9 = tensions.has('9') && !tensions.has('b9') && !tensions.has('#9')
    if (natural9 && tensions.has('13')) {
      n = 13
      tensions.delete('13')
      tensions.delete('9')
    } else if (natural9 && tensions.has('11') && !tensions.has('#11')) {
      n = 11
      tensions.delete('11')
      tensions.delete('9')
    } else if (natural9) {
      n = 9
      tensions.delete('9')
    }
    numberPart = (s.seventh === '7' ? 'maj' : '') + String(n)
  } else if (s.sixth) {
    if (tensions.has('9')) {
      numberPart = '6/9'
      tensions.delete('9')
    } else numberPart = '6'
  }

  if (s.third === 'sus2' || s.third === 'sus4') sus = s.third
  if (!fifthConsumed) {
    if (s.fifth === 'b5') alterations.push('b5')
    else if (s.fifth === '#5') alterations.push('#5')
  }
  const hasExtensionBase = s.seventh === '7' || s.seventh === 'b7' || s.sixth
  for (const t of tensions) {
    if (hasExtensionBase && ALTERATIONS.has(t)) alterations.push(t)
    else adds.push(`add${t}`)
  }
  for (const e of s.extras) adds.push(`add${intervalName(e, 'compound')}`)
  if (s.third === null) omits.push('no3')
  if (s.fifth === null) omits.push('no5')

  let altText = alterations.join('')
  // Right after the root an alteration would read as part of the note name (C + b5 → "Cb5").
  if (altText && quality === '' && numberPart === '' && sus === '') altText = `(${altText})`
  return quality + numberPart + sus + altText + adds.join('') + omits.join('')
}

/** Formats a chord as a common chord symbol, e.g. `F#m7b5`, `Bb/D`, `Csus4add9`. */
export function formatChordSymbol(chord: Chord, options: FormatOptions = {}): string {
  const spelling = options.spelling ?? 'neutral'
  const bass = chord.bass === null ? '' : `/${spellPitchClass(chord.bass, spelling)}`
  return spellPitchClass(chord.root, spelling) + formatSuffix(chord) + bass
}
