/**
 * Scale degrees as used by Harte et al. (2005) chord syntax and by chord symbols
 * ("b7", "#11", "13"). A degree is an optional run of accidentals followed by a number.
 */

const NATURAL_DEGREE_SEMITONES: Readonly<Record<number, number>> = {
  1: 0,
  2: 2,
  3: 4,
  4: 5,
  5: 7,
  6: 9,
  7: 11,
  8: 12,
  9: 14,
  10: 16,
  11: 17,
  12: 19,
  13: 21,
}

/** Converts a degree such as `b3`, `#11` or `bb7` to semitones above the root (may exceed 12). */
export function degreeToSemitones(degree: string): number | null {
  const match = /^([b#♭♯]*)(\d{1,2})$/.exec(degree)
  if (!match) return null
  const [, accidentals = '', num = ''] = match
  const base = NATURAL_DEGREE_SEMITONES[Number(num)]
  if (base === undefined) return null
  let offset = 0
  for (const ch of accidentals) offset += ch === '#' || ch === '♯' ? 1 : -1
  return base + offset
}

/**
 * Canonical degree name for an interval (mod 12) when it appears as a chord tone or an added
 * tone. Tensions use compound names (b9, 9, #9, 11, #11, b13, 13); `simpleNames` returns the
 * single-octave spelling used for Harte bass degrees.
 */
const COMPOUND_NAMES = [
  '1',
  'b9',
  '9',
  '#9',
  '3',
  '11',
  '#11',
  '5',
  'b13',
  '13',
  'b7',
  '7',
] as const
const SIMPLE_NAMES = ['1', 'b2', '2', 'b3', '3', '4', 'b5', '5', 'b6', '6', 'b7', '7'] as const

export function intervalName(interval: number, form: 'compound' | 'simple'): string {
  const i = ((interval % 12) + 12) % 12
  return (form === 'compound' ? COMPOUND_NAMES : SIMPLE_NAMES)[i] ?? '1'
}
