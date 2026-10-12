/** Number of semitones in an octave. */
export const OCTAVE = 12

/** A pitch class: 0 = C, 1 = C#/Db, ..., 11 = B. */
export type PitchClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11

/** Reduces any integer to a pitch class (handles negative numbers). */
export function mod12(n: number): PitchClass {
  return (((n % OCTAVE) + OCTAVE) % OCTAVE) as PitchClass
}
