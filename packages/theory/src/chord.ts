import { mod12, type PitchClass } from './pitch.ts'

/**
 * 12-bit set of intervals above the root: bit i set = the chord contains the pitch class
 * `root + i`. Bit 0 (the root) is always set.
 */
export type IntervalMask = number

/**
 * A chord as a set of pitch classes over a root, plus an optional slash bass.
 *
 * This canonical form makes transposition, equality and simplification trivial and leaves
 * no room for two representations of the same sound. The named structure (third, fifth,
 * seventh, tensions) is derived from it on demand by {@link describe}.
 */
export interface Chord {
  readonly root: PitchClass
  readonly intervals: IntervalMask
  /** Slash bass. null = root position. Never equal to `root`. */
  readonly bass: PitchClass | null
}

export const FULL_MASK = 0xfff

export function makeChord(
  root: number,
  intervals: IntervalMask | Iterable<number>,
  bass: number | null = null,
): Chord {
  let mask = 0
  if (typeof intervals === 'number') mask = intervals & FULL_MASK
  else for (const i of intervals) mask |= 1 << mod12(i)
  const r = mod12(root)
  const b = bass === null ? null : mod12(bass)
  return { root: r, intervals: mask | 1, bass: b === r ? null : b }
}

export function hasInterval(chord: Chord, interval: number): boolean {
  return (chord.intervals & (1 << mod12(interval))) !== 0
}

/** Intervals above the root, ascending (always starts with 0). */
export function intervalsOf(chord: Chord): number[] {
  const out: number[] = []
  for (let i = 0; i < 12; i++) if (chord.intervals & (1 << i)) out.push(i)
  return out
}

/** Absolute pitch classes of the chord, root first (the slash bass is not included). */
export function pitchClassesOf(chord: Chord): PitchClass[] {
  return intervalsOf(chord).map((i) => mod12(chord.root + i))
}

export function transpose(chord: Chord, semitones: number): Chord {
  return {
    root: mod12(chord.root + semitones),
    intervals: chord.intervals,
    bass: chord.bass === null ? null : mod12(chord.bass + semitones),
  }
}

/** Stable identity string, e.g. for use as a map key. */
export function chordKey(chord: Chord): string {
  return `${chord.root}:${chord.intervals.toString(16)}:${chord.bass ?? '-'}`
}

export function chordEquals(a: Chord, b: Chord): boolean {
  return a.root === b.root && a.intervals === b.intervals && a.bass === b.bass
}

// ---------------------------------------------------------------------------------------------
// Structure

export type Third = 'M3' | 'm3' | 'sus2' | 'sus4'
export type Fifth = 'P5' | 'b5' | '#5'
/** `7` = major seventh, `b7` = minor seventh, `bb7` = diminished seventh. */
export type Seventh = '7' | 'b7' | 'bb7'
export type Tension = 'b9' | '9' | '#9' | '11' | '#11' | 'b13' | '13'

/** Tensions in ascending order, with their interval above the root (mod 12). */
export const TENSIONS: readonly (readonly [Tension, number])[] = [
  ['b9', 1],
  ['9', 2],
  ['#9', 3],
  ['11', 5],
  ['#11', 6],
  ['b13', 8],
  ['13', 9],
]

const THIRD_INTERVAL: Readonly<Record<Third, number>> = { M3: 4, m3: 3, sus2: 2, sus4: 5 }
const FIFTH_INTERVAL: Readonly<Record<Fifth, number>> = { P5: 7, b5: 6, '#5': 8 }
const SEVENTH_INTERVAL: Readonly<Record<Seventh, number>> = { '7': 11, b7: 10, bb7: 9 }

export interface ChordStructure {
  third: Third | null
  fifth: Fifth | null
  seventh: Seventh | null
  /** Added sixth (only when there is no seventh; with a seventh the same pitch is the 13th). */
  sixth: boolean
  /** Tensions present, in ascending order. */
  tensions: Tension[]
  /** Intervals no other slot could explain (e.g. both b7 and 7), ascending. */
  extras: number[]
}

/**
 * Names every interval of a chord. The classification is total: each set bit ends up in
 * exactly one slot, so `structureToIntervals(describe(c))` always equals `c.intervals`.
 */
export function describe(chord: Chord): ChordStructure {
  const has = (i: number) => (chord.intervals & (1 << i)) !== 0
  let used = 1

  const third: Third | null = has(4)
    ? 'M3'
    : has(3)
      ? 'm3'
      : has(5)
        ? 'sus4'
        : has(2)
          ? 'sus2'
          : null
  if (third) used |= 1 << THIRD_INTERVAL[third]

  let fifth: Fifth | null = null
  if (has(7)) fifth = 'P5'
  else if (third === 'm3' && has(6)) fifth = 'b5'
  else if (third === 'M3' && has(8)) fifth = '#5'
  else if (has(6)) fifth = 'b5'
  else if (has(8)) fifth = '#5'
  if (fifth) used |= 1 << FIFTH_INTERVAL[fifth]

  let seventh: Seventh | null = null
  if (has(10)) seventh = 'b7'
  else if (has(11)) seventh = '7'
  else if (third === 'm3' && fifth === 'b5' && has(9)) seventh = 'bb7'
  if (seventh) used |= 1 << SEVENTH_INTERVAL[seventh]

  const sixth = seventh === null && has(9)
  if (sixth) used |= 1 << 9

  const tensions: Tension[] = []
  for (const [name, interval] of TENSIONS) {
    if (has(interval) && !(used & (1 << interval))) {
      tensions.push(name)
      used |= 1 << interval
    }
  }

  const extras: number[] = []
  for (let i = 1; i < 12; i++) if (has(i) && !(used & (1 << i))) extras.push(i)

  return { third, fifth, seventh, sixth, tensions, extras }
}

export function structureToIntervals(s: ChordStructure): IntervalMask {
  let mask = 1
  if (s.third) mask |= 1 << THIRD_INTERVAL[s.third]
  if (s.fifth) mask |= 1 << FIFTH_INTERVAL[s.fifth]
  if (s.seventh) mask |= 1 << SEVENTH_INTERVAL[s.seventh]
  if (s.sixth) mask |= 1 << 9
  for (const t of s.tensions) mask |= 1 << tensionInterval(t)
  for (const e of s.extras) mask |= 1 << mod12(e)
  return mask
}

const TENSION_INTERVAL: Readonly<Record<Tension, number>> = Object.fromEntries(TENSIONS) as Record<
  Tension,
  number
>

export function tensionInterval(t: Tension): number {
  return TENSION_INTERVAL[t]
}

// ---------------------------------------------------------------------------------------------
// Chord tones with musical roles (used by the fidelity score)

export type ToneRole = 'root' | 'third' | 'fifth' | 'seventh' | 'sixth' | 'tension' | 'bass'

export interface ChordTone {
  /** Interval above the root, 0..11. */
  interval: number
  role: ToneRole
  /** For `fifth`: altered (b5/#5) or the defining tone of a power chord. */
  essential: boolean
  /** For `tension`: the highest tension, which names the chord (the 13 of a C13). */
  highest: boolean
}

/** The chord's tones with roles, plus the slash bass when it is not already a chord tone. */
export function chordTones(chord: Chord): ChordTone[] {
  const s = describe(chord)
  const tones: ChordTone[] = [{ interval: 0, role: 'root', essential: true, highest: false }]
  if (s.third) {
    tones.push({
      interval: THIRD_INTERVAL[s.third],
      role: 'third',
      essential: true,
      highest: false,
    })
  }
  if (s.fifth) {
    tones.push({
      interval: FIFTH_INTERVAL[s.fifth],
      role: 'fifth',
      essential: s.fifth !== 'P5' || s.third === null,
      highest: false,
    })
  }
  if (s.seventh) {
    tones.push({
      interval: SEVENTH_INTERVAL[s.seventh],
      role: 'seventh',
      essential: true,
      highest: false,
    })
  }
  if (s.sixth) tones.push({ interval: 9, role: 'sixth', essential: true, highest: false })
  s.tensions.forEach((t, i) => {
    tones.push({
      interval: tensionInterval(t),
      role: 'tension',
      essential: false,
      highest: i === s.tensions.length - 1 && s.extras.length === 0,
    })
  })
  for (const e of s.extras) {
    tones.push({ interval: e, role: 'tension', essential: false, highest: false })
  }
  if (chord.bass !== null) {
    const bassInterval = mod12(chord.bass - chord.root)
    if (!(chord.intervals & (1 << bassInterval))) {
      tones.push({ interval: bassInterval, role: 'bass', essential: true, highest: false })
    }
  }
  return tones
}

// ---------------------------------------------------------------------------------------------
// Simplification and identification

export type SimplifyLevel = 'none' | 'drop-tensions'

/** `drop-tensions` removes 9ths, 11ths and 13ths (C9 → C7, Cadd9 → C, C6/9 → C6, m11 → m7). */
export function simplify(chord: Chord, level: SimplifyLevel): Chord {
  if (level === 'none') return chord
  const s = describe(chord)
  if (s.tensions.length === 0 && s.extras.length === 0) return chord
  const intervals = structureToIntervals({ ...s, tensions: [], extras: [] })
  return makeChord(chord.root, intervals, chord.bass)
}

/**
 * Names a set of sounding pitch classes relative to a known root, e.g. the notes of the shape
 * `xx3210` over F → Fmaj7. A missing perfect fifth is treated as implied (open-chord voicings
 * often drop it) when a third is present and no altered fifth is.
 */
export function identifyChord(
  pitchClasses: Iterable<number>,
  root: number,
  lowest: number | null = null,
): Chord {
  let mask = 1
  for (const pc of pitchClasses) mask |= 1 << mod12(pc - root)
  const hasThird = (mask & ((1 << 3) | (1 << 4))) !== 0
  const hasFifth = (mask & ((1 << 6) | (1 << 7) | (1 << 8))) !== 0
  if (hasThird && !hasFifth) mask |= 1 << 7
  return makeChord(root, mask, lowest)
}
