/** Six-string guitar tunings. Strings are listed from the lowest (6th) to the highest (1st). */
export interface Tuning {
  id: string
  /** MIDI note number of each open string, low E first. */
  midi: readonly [number, number, number, number, number, number]
}

export const STANDARD: Tuning = { id: 'standard', midi: [40, 45, 50, 55, 59, 64] }

/** Half a step down (Eb Ab Db Gb Bb Eb), common for playing along with recordings. */
export const EB_STANDARD: Tuning = { id: 'eb-standard', midi: [39, 44, 49, 54, 58, 63] }

export const TUNINGS: readonly Tuning[] = [STANDARD, EB_STANDARD]

/**
 * Semitone shift of a tuning relative to standard when every string is shifted by the same
 * amount (so standard-tuning chord shapes still apply), otherwise null (e.g. drop D).
 */
export function uniformShift(tuning: Tuning): number | null {
  const shift = tuning.midi[0] - STANDARD.midi[0]
  return tuning.midi.every((m, i) => m - (STANDARD.midi[i] ?? 0) === shift) ? shift : null
}
