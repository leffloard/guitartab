/**
 * Guitar chord shapes ("voicings") and their physical analysis.
 *
 * Convention: arrays are indexed by string from the LOW E string (index 0 = 6th string) to
 * the high E string (index 5). Frets are relative to the nut or capo; null = muted, 0 = open.
 */
import { mod12, type PitchClass } from './pitch.ts'
import { STANDARD, type Tuning } from './tuning.ts'

export type Fret = number | null
export type Frets = readonly Fret[]
/** 1 = index … 4 = pinky; null = not fretted (open, muted) or unknown. */
export type Finger = number | null

export interface Voicing {
  /** Stable id derived from the frets, e.g. `x-x-3-2-1-0`. */
  readonly id: string
  readonly frets: Frets
  readonly fingers: readonly Finger[]
  /** Where the shape comes from: `curated`, `chords-db` or `generated`. */
  readonly source: string
}

export const STRING_COUNT = 6

export function voicingId(frets: Frets): string {
  return frets.map((f) => (f === null ? 'x' : String(f))).join('-')
}

export function makeVoicing(frets: Frets, fingers: readonly Finger[], source: string): Voicing {
  return { id: voicingId(frets), frets, fingers, source }
}

/** Sounding MIDI notes per string (null for muted strings). `offset` = capo + tuning shift. */
export function soundingMidi(
  frets: Frets,
  tuning: Tuning = STANDARD,
  offset = 0,
): (number | null)[] {
  return frets.map((f, i) => (f === null ? null : (tuning.midi[i] ?? 0) + offset + f))
}

export interface PlayedNotes {
  /** Pitch classes of the sounding strings, from low to high. */
  pcs: PitchClass[]
  /** Pitch class of the lowest sounding string. */
  lowest: PitchClass
}

/** The notes a shape plays (in standard-tuning shape space unless a tuning/offset is given). */
export function playedNotes(frets: Frets, tuning: Tuning = STANDARD, offset = 0): PlayedNotes {
  const pcs: PitchClass[] = []
  for (const m of soundingMidi(frets, tuning, offset)) if (m !== null) pcs.push(mod12(m))
  return { pcs, lowest: pcs[0] ?? 0 }
}

export interface Barre {
  fret: number
  /** String indices covered by the barre (inclusive, 0 = low E). */
  from: number
  to: number
  /** Number of strings the finger lies across. */
  strings: number
  /** A barre across five or six strings (the classic F / Bm barre). */
  full: boolean
}

export interface ShapeInfo {
  sounding: number
  /** Index of the lowest / highest sounding string. */
  lowest: number
  highest: number
  minFret: number
  maxFret: number
  /** maxFret − minFret over fretted strings (0 if at most one fretted fret). */
  span: number
  fingersUsed: number
  barres: Barre[]
  /** Muted strings between the lowest and highest sounding strings. */
  mutedInner: number
  /** Muted strings above the highest sounding string. */
  mutedTreble: number
  /** Open strings above the lowest sounding string. */
  openAboveBass: number
}

/** Barres implied by a fingering: one finger pressing two or more strings at the same fret. */
export function findBarres(frets: Frets, fingers: readonly Finger[]): Barre[] {
  const byFinger = new Map<number, number[]>()
  frets.forEach((f, i) => {
    const finger = fingers[i]
    if (f !== null && f > 0 && finger != null && finger > 0) {
      const list = byFinger.get(finger) ?? []
      list.push(i)
      byFinger.set(finger, list)
    }
  })
  const barres: Barre[] = []
  for (const strings of byFinger.values()) {
    if (strings.length < 2) continue
    const fret = frets[strings[0] ?? 0] ?? 0
    const from = Math.min(...strings)
    const to = Math.max(...strings)
    const count = to - from + 1
    barres.push({ fret, from, to, strings: count, full: count >= 5 })
  }
  return barres.sort((a, b) => a.from - b.from || a.fret - b.fret)
}

export function analyzeShape(v: Pick<Voicing, 'frets' | 'fingers'>): ShapeInfo {
  const { frets, fingers } = v
  const soundingIdx = frets.flatMap((f, i) => (f === null ? [] : [i]))
  const lowest = soundingIdx[0] ?? 0
  const highest = soundingIdx[soundingIdx.length - 1] ?? 0
  const fretted = frets.filter((f): f is number => f !== null && f > 0)
  const minFret = fretted.length > 0 ? Math.min(...fretted) : 0
  const maxFret = fretted.length > 0 ? Math.max(...fretted) : 0
  const used = new Set<number>()
  frets.forEach((f, i) => {
    const finger = fingers[i]
    if (f !== null && f > 0) used.add(finger != null && finger > 0 ? finger : 100 + i)
  })
  let mutedInner = 0
  for (let i = lowest; i <= highest; i++) if (frets[i] === null) mutedInner++
  let openAboveBass = 0
  for (let i = lowest + 1; i < frets.length; i++) if (frets[i] === 0) openAboveBass++
  return {
    sounding: soundingIdx.length,
    lowest,
    highest,
    minFret,
    maxFret,
    span: maxFret - minFret,
    fingersUsed: used.size,
    barres: findBarres(frets, fingers),
    mutedInner,
    mutedTreble: frets.length - 1 - highest,
    openAboveBass,
  }
}

/**
 * Derives a plausible fingering for a shape without one (generated shapes, incomplete data).
 * Up to four fretted strings get one finger each, ordered by fret then string. With more,
 * the index finger barres the lowest fret, which requires every string under the barre to be
 * fretted (an open or muted string under a barre is impossible). Returns null if the shape
 * cannot be fingered with four fingers.
 */
export function assignFingers(frets: Frets): Finger[] | null {
  const fingers: Finger[] = frets.map(() => null)
  const fretted = frets
    .map((f, i) => ({ f, i }))
    .filter((x): x is { f: number; i: number } => x.f !== null && x.f > 0)
    .sort((a, b) => a.f - b.f || a.i - b.i)
  if (fretted.length === 0) return fingers
  if (fretted.length <= 4) {
    fretted.forEach(({ i }, k) => (fingers[i] = k + 1))
    return fingers
  }
  const minFret = fretted[0]?.f ?? 0
  const atMin = fretted.filter((x) => x.f === minFret).map((x) => x.i)
  const from = Math.min(...atMin)
  const to = Math.max(...atMin)
  for (let i = from; i <= to; i++) {
    const f = frets[i]
    if (f === null || f === undefined || f < minFret) return null
  }
  const rest = fretted.filter((x) => !(x.f === minFret && x.i >= from && x.i <= to))
  if (rest.length > 3) return null
  for (let i = from; i <= to; i++) if (frets[i] === minFret) fingers[i] = 1
  rest.forEach(({ i }, k) => (fingers[i] = k + 2))
  return fingers
}
