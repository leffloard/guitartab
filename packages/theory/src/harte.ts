/**
 * Harte et al. (2005) chord labels, as produced by the analyzer and consumed by mir_eval:
 * `C:maj`, `A:min7`, `G:7/3`, `D:(1,b3,5)`, `E:min7(*5)`, `N` (no chord), `X` (unknown).
 *
 * Shorthands follow mir_eval 0.8.2 (`QUALITIES` plus `EXTENDED_QUALITY_REDUX`): e.g. `13` is
 * 7 + {9, 11, 13}. That differs from pop chord symbols, where C13 conventionally omits the 11.
 */
import { describe, makeChord, type Chord, type IntervalMask } from './chord.ts'
import { degreeToSemitones, intervalName } from './intervals.ts'
import { mod12, parseNote, spellPitchClass, type Spelling } from './pitch.ts'

function maskOf(...intervals: number[]): IntervalMask {
  return intervals.reduce((m, i) => m | (1 << mod12(i)), 0)
}

/** Shorthands that the formatter may emit (single-octave qualities). */
const BASE_SHORTHANDS: readonly (readonly [string, IntervalMask])[] = [
  ['maj', maskOf(0, 4, 7)],
  ['min', maskOf(0, 3, 7)],
  ['dim', maskOf(0, 3, 6)],
  ['aug', maskOf(0, 4, 8)],
  ['sus4', maskOf(0, 5, 7)],
  ['sus2', maskOf(0, 2, 7)],
  ['7', maskOf(0, 4, 7, 10)],
  ['maj7', maskOf(0, 4, 7, 11)],
  ['min7', maskOf(0, 3, 7, 10)],
  ['minmaj7', maskOf(0, 3, 7, 11)],
  ['maj6', maskOf(0, 4, 7, 9)],
  ['min6', maskOf(0, 3, 7, 9)],
  ['dim7', maskOf(0, 3, 6, 9)],
  ['hdim7', maskOf(0, 3, 6, 10)],
  ['5', maskOf(0, 7)],
  ['1', maskOf(0)],
]

/** Extended shorthands accepted when parsing (mir_eval's EXTENDED_QUALITY_REDUX). */
const EXTENDED_SHORTHANDS: Readonly<Record<string, IntervalMask>> = {
  '9': maskOf(0, 4, 7, 10, 2),
  maj9: maskOf(0, 4, 7, 11, 2),
  min9: maskOf(0, 3, 7, 10, 2),
  '11': maskOf(0, 4, 7, 10, 2, 5),
  min11: maskOf(0, 3, 7, 10, 2, 5),
  '13': maskOf(0, 4, 7, 10, 2, 5, 9),
  maj13: maskOf(0, 4, 7, 11, 2, 5, 9),
  min13: maskOf(0, 3, 7, 10, 2, 5, 9),
}

const SHORTHANDS: ReadonlyMap<string, IntervalMask> = new Map([
  ...BASE_SHORTHANDS,
  ...Object.entries(EXTENDED_SHORTHANDS),
])

export type HarteLabel = { kind: 'chord'; chord: Chord } | { kind: 'no-chord' }

const HARTE_RE = /^([A-G][b#]*)(?::([^/(]*)(?:\(([^)]*)\))?)?(?:\/([b#]*\d{1,2}))?$/

/** Parses a Harte label. Returns null if the label is not valid Harte syntax. */
export function parseHarte(input: string): HarteLabel | null {
  const label = input.trim()
  if (label === 'N' || label === 'X') return { kind: 'no-chord' }
  const m = HARTE_RE.exec(label)
  if (!m) return null
  const [, rootText = '', shorthandText, degreeText, bassText] = m
  const root = parseNote(rootText)
  if (root === null) return null

  let mask: number
  if (shorthandText === undefined) mask = SHORTHANDS.get('maj') ?? 0
  else if (shorthandText === '') {
    if (degreeText === undefined) return null // "C:" alone
    mask = 0
  } else {
    const found = SHORTHANDS.get(shorthandText)
    if (found === undefined) return null
    mask = found
  }

  if (degreeText !== undefined) {
    for (const raw of degreeText.split(',')) {
      const item = raw.trim()
      if (item === '') continue
      const omit = item.startsWith('*')
      const semis = degreeToSemitones(omit ? item.slice(1) : item)
      if (semis === null) return null
      const bit = 1 << mod12(semis)
      mask = omit ? mask & ~bit : mask | bit
    }
  }

  let bass: number | null = null
  if (bassText !== undefined) {
    const semis = degreeToSemitones(bassText)
    if (semis === null) return null
    bass = root + semis
  }
  return { kind: 'chord', chord: makeChord(root, mask, bass) }
}

function popcount(n: number): number {
  let c = 0
  for (let x = n; x; x &= x - 1) c++
  return c
}

/** Harte degree name for an interval, chosen from the chord's structure (b3 vs #9, 6 vs 13). */
function degreeName(chord: Chord, interval: number): string {
  const s = describe(chord)
  switch (interval) {
    case 2:
      return s.third === 'sus2' ? '2' : '9'
    case 3:
      return s.third === 'm3' ? 'b3' : '#9'
    case 4:
      return '3'
    case 5:
      return s.third === 'sus4' ? '4' : '11'
    case 6:
      return s.fifth === 'b5' ? 'b5' : '#11'
    case 7:
      return '5'
    case 8:
      return s.fifth === '#5' ? '#5' : 'b13'
    case 9:
      return s.seventh === 'bb7' ? 'bb7' : s.sixth ? '6' : '13'
    default:
      return intervalName(interval, 'compound')
  }
}

/** Formats a chord in Harte syntax: the largest matching shorthand plus extra degrees. */
export function formatHarte(chord: Chord, spelling: Spelling = 'neutral'): string {
  let best: readonly [string, IntervalMask] | undefined
  for (const entry of BASE_SHORTHANDS) {
    const [, mask] = entry
    if ((mask & chord.intervals) === mask && (!best || popcount(mask) > popcount(best[1]))) {
      best = entry
    }
  }
  // '1' (just the root) always matches, so `best` is defined.
  const [name, mask] = best ?? ['1', 1]
  const extra: string[] = []
  for (let i = 1; i < 12; i++) {
    if (chord.intervals & (1 << i) && !(mask & (1 << i))) extra.push(degreeName(chord, i))
  }
  let text = spellPitchClass(chord.root, spelling)
  if (name === '1' && extra.length > 0) text += `:(1,${extra.join(',')})`
  else {
    text += `:${name}`
    if (extra.length > 0) text += `(${extra.join(',')})`
  }
  if (chord.bass !== null) text += `/${intervalName(chord.bass - chord.root, 'simple')}`
  return text
}
