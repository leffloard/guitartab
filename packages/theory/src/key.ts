/**
 * Key-signature estimation for enharmonic spelling. BarreFree only needs the key to decide
 * between C# and Db, so it scores the 12 major key signatures (a minor key shares its
 * relative major's signature) by how well the chords fit them.
 */
import { describe, type Chord } from './chord.ts'
import { mod12, PITCH_NAMES, type PitchClass, type Spelling } from './pitch.ts'

const MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11] as const
/** Diatonic triad quality on each degree of the major scale. */
const DIATONIC_TRIADS = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'] as const
/** Accidentals in the signature of the major key on each tonic (+ = sharps, − = flats). */
const SIGNATURE = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5] as const

export interface KeySignature {
  /** Tonic of the major key with this signature. */
  tonic: PitchClass
  /** Number of sharps (positive) or flats (negative). */
  accidentals: number
}

export interface WeightedChord {
  chord: Chord
  weight: number
}

function triadQuality(chord: Chord): 'maj' | 'min' | 'dim' | null {
  const s = describe(chord)
  if (s.third === 'M3' && (s.fifth === 'P5' || s.fifth === null)) return 'maj'
  if (s.third === 'm3' && (s.fifth === 'P5' || s.fifth === null)) return 'min'
  if (s.third === 'm3' && s.fifth === 'b5') return 'dim'
  return null
}

/**
 * Picks the major key signature that best explains the chords: +1 per chord whose root is in
 * the scale, +1 more when its triad matches the diatonic triad on that degree (weighted).
 * Ties go to the signature with fewer accidentals, then to sharps.
 */
export function estimateKeySignature(chords: readonly WeightedChord[]): KeySignature {
  let best: KeySignature = { tonic: 0, accidentals: 0 }
  let bestScore = -1
  for (let tonic = 0; tonic < 12; tonic++) {
    let score = 0
    for (const { chord, weight } of chords) {
      const degree = MAJOR_SCALE.indexOf(mod12(chord.root - tonic) as (typeof MAJOR_SCALE)[number])
      if (degree < 0) continue
      score += weight
      if (triadQuality(chord) === DIATONIC_TRIADS[degree]) score += weight
    }
    const accidentals = SIGNATURE[tonic] ?? 0
    const better =
      score > bestScore + 1e-9 ||
      (Math.abs(score - bestScore) <= 1e-9 &&
        (Math.abs(accidentals) < Math.abs(best.accidentals) ||
          (Math.abs(accidentals) === Math.abs(best.accidentals) && accidentals > best.accidentals)))
    if (better) {
      best = { tonic: mod12(tonic), accidentals }
      bestScore = score
    }
  }
  return best
}

/**
 * Spelling for a key signature: diatonic notes use the signature's accidental (F# in D major,
 * Bb in F major), non-diatonic ones the neutral chart spelling.
 */
export function spellingForKey(key: KeySignature): Spelling {
  const diatonicTable = key.accidentals < 0 ? PITCH_NAMES.flat : PITCH_NAMES.sharp
  const names: string[] = []
  for (let pc = 0; pc < 12; pc++) {
    const diatonic = MAJOR_SCALE.includes(mod12(pc - key.tonic) as (typeof MAJOR_SCALE)[number])
    names.push(
      (diatonic && key.accidentals !== 0 ? diatonicTable[pc] : PITCH_NAMES.neutral[pc]) ?? '?',
    )
  }
  return { names }
}
