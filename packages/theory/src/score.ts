/**
 * Scores for choosing a voicing: how hard it is to play (`difficulty`) and how faithfully it
 * renders the requested chord (`fidelity`). See docs/algorithms/transform-engine.md.
 */
import { chordTones, describe, type Chord, type ChordTone } from './chord.ts'
import { mod12, type PitchClass } from './pitch.ts'
import type { PlayedNotes, ShapeInfo } from './voicing.ts'

// ---------------------------------------------------------------------------------------------
// Difficulty

/**
 * Difficulty weights in hundredths of a point (integers keep sums exact and order-independent).
 */
export interface DifficultyWeights {
  base: number
  fullBarre: number
  miniBarre: number
  perFinger: number
  /** Per fret of span beyond `freeSpan`. */
  perExtraSpan: number
  freeSpan: number
  /** Per fret the highest fretted note sits above `freePosition`. */
  perPosition: number
  freePosition: number
  /** Muted string between two sounding strings (hard to strum cleanly). */
  mutedInner: number
  /** Muted string above the highest sounding one. */
  mutedTreble: number
  /** Bonus (negative) per open string above the lowest sounding string. */
  openString: number
}

export const DEFAULT_DIFFICULTY: DifficultyWeights = {
  base: 100,
  fullBarre: 600,
  miniBarre: 200,
  perFinger: 50,
  perExtraSpan: 100,
  freeSpan: 2,
  perPosition: 30,
  freePosition: 3,
  mutedInner: 150,
  mutedTreble: 50,
  openString: -40,
}

export interface DifficultyBreakdown {
  /** Total in points (hundredths / 100). */
  total: number
  /** Each term in hundredths of a point. */
  parts: {
    base: number
    barre: number
    fingers: number
    span: number
    position: number
    mutedInner: number
    mutedTreble: number
    openStrings: number
  }
}

/**
 * Difficulty of a shape. Muted strings on the bass side cost nothing and open strings only
 * count above the lowest sounding string, so a wrong-bass inversion (C/E for C) is never
 * cheaper than the root-position shape just because it rings one more open string.
 */
export function difficulty(
  info: ShapeInfo,
  w: DifficultyWeights = DEFAULT_DIFFICULTY,
): DifficultyBreakdown {
  const parts = {
    base: w.base,
    barre: info.barres.reduce((sum, b) => sum + (b.full ? w.fullBarre : w.miniBarre), 0),
    fingers: w.perFinger * info.fingersUsed,
    span: w.perExtraSpan * Math.max(0, info.span - w.freeSpan),
    position: w.perPosition * Math.max(0, info.maxFret - w.freePosition),
    mutedInner: w.mutedInner * info.mutedInner,
    mutedTreble: w.mutedTreble * info.mutedTreble,
    openStrings: w.openString * info.openAboveBass,
  }
  // A zero bonus would otherwise be -0 (−40 × 0), which deep equality tells apart from 0.
  parts.openStrings = parts.openStrings === 0 ? 0 : parts.openStrings
  const hundredths = Object.values(parts).reduce((a, b) => a + b, 0)
  return { total: hundredths / 100, parts }
}

// ---------------------------------------------------------------------------------------------
// Fidelity

export interface FidelityWeights {
  root: number
  third: number
  fifth: number
  /** Altered fifth, or the fifth of a power chord: it defines the sound. */
  essentialFifth: number
  seventh: number
  sixth: number
  highestTension: number
  tension: number
  /** A slash bass that is not otherwise a chord tone (the D of C/D). */
  slashBass: number
  /** Penalties for pitch classes the voicing adds. */
  addedSeventh: number
  addedNinth: number
  addedSixth: number
  addedFourth: number
  addedFifth: number
  addedThirdToPowerChord: number
  addedOther: number
  clash: number
  /** Lowest note differs from the written slash bass / from the root. */
  wrongSlashBass: number
  wrongRootBass: number
}

export const DEFAULT_FIDELITY: FidelityWeights = {
  root: 3,
  third: 3,
  fifth: 1,
  essentialFifth: 3,
  seventh: 1.5,
  sixth: 1.5,
  highestTension: 1,
  tension: 0.5,
  slashBass: 1.5,
  // The usual barre-free substitutes add a seventh (F → Fmaj7, Bm → Bm7, B → B7), so a seventh
  // is the cheapest colour. Two added colours (F6/9 for F) fall below the easy-mode floor.
  addedSeventh: 0.8,
  addedNinth: 0.8,
  addedSixth: 1,
  addedFourth: 1,
  addedFifth: 0.2,
  addedThirdToPowerChord: 0.5,
  addedOther: 2,
  clash: 10,
  wrongSlashBass: 1.5,
  // On a guitar the lowest string defines the inversion: a wrong bass is as bad as a wrong
  // slash bass, so inversions only win when they are much easier.
  wrongRootBass: 1.5,
}

function toneWeight(t: ChordTone, w: FidelityWeights): number {
  switch (t.role) {
    case 'root':
      return w.root
    case 'third':
      return w.third
    case 'fifth':
      return t.essential ? w.essentialFifth : w.fifth
    case 'seventh':
      return w.seventh
    case 'sixth':
      return w.sixth
    case 'tension':
      return t.highest ? w.highestTension : w.tension
    case 'bass':
      return w.slashBass
  }
}

/**
 * True if playing `interval` (above the target root) on top of the target contradicts one of
 * its defining tones: the other third (major ↔ minor, or a third added to a sus chord), the
 * other seventh, or a perfect fifth against an altered one.
 */
export function clashes(target: Chord, interval: number): boolean {
  const s = describe(target)
  const i = mod12(interval)
  if ((i === 3 || i === 4) && s.third !== null) return true
  if ((i === 10 || i === 11) && s.seventh !== null) return true
  if (i === 7 && (s.fifth === 'b5' || s.fifth === '#5')) return true
  return false
}

function addedPenalty(target: Chord, interval: number, w: FidelityWeights): number {
  if (clashes(target, interval)) return w.clash
  switch (interval) {
    case 10:
    case 11:
      return w.addedSeventh
    case 2:
      return w.addedNinth
    case 9:
      return w.addedSixth
    case 5:
      return w.addedFourth
    case 7:
      return w.addedFifth
    case 3:
    case 4:
      return describe(target).third === null ? w.addedThirdToPowerChord : w.addedOther
    default:
      return w.addedOther
  }
}

/**
 * Tones a voicing may leave out without changing what the chord is: a perfect fifth and the
 * natural 9 / 11 below the top tension of an extended chord (C7 `x32310` has no G, a C13
 * voicing rarely has the 9). Altered tensions (b9, #9, #11, b13) define the chord and stay.
 */
function isOptional(t: ChordTone): boolean {
  if (t.role === 'fifth') return !t.essential
  return t.role === 'tension' && !t.highest && (t.interval === 2 || t.interval === 5)
}

/**
 * Everything about a target chord that scoring needs, computed once and reused for every
 * candidate shape (the hot path when ranking hundreds of shapes for each capo).
 */
export interface PreparedTarget {
  chord: Chord
  /** Bitmask of the target's tone intervals (including a non-chord slash bass). */
  toneMask: number
  /** Bitmask of the tones that must sound. */
  requiredMask: number
  /** Weight of each interval as a target tone (0 if not a tone). */
  toneWeights: readonly number[]
  /** Penalty for each interval if a voicing adds it. */
  addedPenalties: readonly number[]
  clashMask: number
  total: number
  wantedBass: PitchClass
  wrongBassPenalty: number
}

export function prepareTarget(
  target: Chord,
  w: FidelityWeights = DEFAULT_FIDELITY,
): PreparedTarget {
  const toneWeights = new Array<number>(12).fill(0)
  let toneMask = 0
  let requiredMask = 0
  let total = 0
  for (const t of chordTones(target)) {
    const weight = toneWeight(t, w)
    toneWeights[t.interval] = weight
    toneMask |= 1 << t.interval
    if (!isOptional(t)) requiredMask |= 1 << t.interval
    total += weight
  }
  const addedPenalties = new Array<number>(12).fill(0)
  let clashMask = 0
  for (let i = 0; i < 12; i++) {
    if (toneMask & (1 << i)) continue
    addedPenalties[i] = addedPenalty(target, i, w)
    if (clashes(target, i)) clashMask |= 1 << i
  }
  return {
    chord: target,
    toneMask,
    requiredMask,
    toneWeights,
    addedPenalties,
    clashMask,
    total,
    wantedBass: target.bass ?? target.root,
    wrongBassPenalty: target.bass === null ? w.wrongRootBass : w.wrongSlashBass,
  }
}

function playedMask(target: Chord, played: PlayedNotes): number {
  let mask = 0
  for (const pc of played.pcs) mask |= 1 << mod12(pc - target.root)
  return mask
}

export interface FidelityResult {
  /** 0..1, where 1 = every required chord tone present, nothing added, correct bass. */
  value: number
  /** Required chord tones (intervals above the root) the voicing does not play. */
  missing: number[]
  /** Intervals the voicing plays that are not in the chord. */
  added: number[]
  /** Some added note contradicts a defining tone (see {@link clashes}). */
  clash: boolean
  /** The lowest note is the written slash bass, or the root for root-position chords. */
  bassOk: boolean
}

/**
 * Fidelity of `played` to the prepared target (both in the same space, e.g. shape space with
 * the capo removed). Optional tones that are left out cost nothing, consistent with
 * {@link realizes}; they still count in the denominator.
 */
export function fidelityOf(p: PreparedTarget, played: PlayedNotes): FidelityResult {
  const mask = playedMask(p.chord, played)
  let penalty = 0
  const missing: number[] = []
  const added: number[] = []
  for (let i = 0; i < 12; i++) {
    const bit = 1 << i
    if (p.requiredMask & bit && !(mask & bit)) {
      penalty += p.toneWeights[i] ?? 0
      missing.push(i)
    } else if (mask & bit && !(p.toneMask & bit)) {
      penalty += p.addedPenalties[i] ?? 0
      added.push(i)
    }
  }
  const bassOk = played.lowest === p.wantedBass
  if (!bassOk) penalty += p.wrongBassPenalty
  const value = Math.min(1, Math.max(0, 1 - penalty / p.total))
  return { value, missing, added, clash: (mask & p.clashMask) !== 0, bassOk }
}

export function fidelity(
  target: Chord,
  played: PlayedNotes,
  w: FidelityWeights = DEFAULT_FIDELITY,
): FidelityResult {
  return fidelityOf(prepareTarget(target, w), played)
}

/**
 * Strict check used by the `original` and `capo` modes: the voicing plays the chord as written.
 * Every required tone sounds (optional ones: see {@link isOptional}), nothing is added, and the
 * lowest note is the written bass (the root unless it is a slash chord).
 */
export function realizesPrepared(p: PreparedTarget, played: PlayedNotes): boolean {
  const mask = playedMask(p.chord, played)
  return (
    (mask & ~p.toneMask) === 0 && (p.requiredMask & ~mask) === 0 && played.lowest === p.wantedBass
  )
}

export function realizes(target: Chord, played: PlayedNotes): boolean {
  return realizesPrepared(prepareTarget(target), played)
}
