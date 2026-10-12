/** Number of semitones in an octave. */
export const OCTAVE = 12

/** A pitch class: 0 = C, 1 = C#/Db, ..., 11 = B. */
export type PitchClass = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11

/** Reduces any integer to a pitch class (handles negative numbers). */
export function mod12(n: number): PitchClass {
  return (((n % OCTAVE) + OCTAVE) % OCTAVE) as PitchClass
}

/**
 * How to spell black-key pitch classes.
 * - `sharp` / `flat`: always use that accidental.
 * - `neutral`: the most common chart spelling (C# Eb F# Ab Bb), used when no key is known.
 * - `{ names }`: an explicit 12-entry table, e.g. built from a key signature (see key.ts).
 */
export type Spelling = 'sharp' | 'flat' | 'neutral' | { readonly names: readonly string[] }

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const
const NEUTRAL_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'] as const

/** Returns the note name of a pitch class with the given spelling. */
export function spellPitchClass(pc: PitchClass, spelling: Spelling = 'neutral'): string {
  if (typeof spelling === 'object') return spelling.names[pc] ?? NEUTRAL_NAMES[pc]
  const table =
    spelling === 'sharp' ? SHARP_NAMES : spelling === 'flat' ? FLAT_NAMES : NEUTRAL_NAMES
  return table[pc]
}

export const PITCH_NAMES = { sharp: SHARP_NAMES, flat: FLAT_NAMES, neutral: NEUTRAL_NAMES } as const

const LETTER_PC: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export interface ParsedNote {
  pc: PitchClass
  /** Number of characters consumed from the input. */
  length: number
}

/**
 * Parses a note name at the start of `input`: a letter A–G followed by any number of
 * accidentals (`#`, `b`, `♯`, `♭`). Returns null if `input` does not start with a note.
 */
export function parseNoteAt(input: string, start = 0): ParsedNote | null {
  const letter = input[start]
  if (letter === undefined) return null
  const base = LETTER_PC[letter]
  if (base === undefined) return null
  let offset = 0
  let i = start + 1
  for (; i < input.length; i++) {
    const ch = input[i]
    if (ch === '#' || ch === '♯') offset += 1
    else if (ch === 'b' || ch === '♭') offset -= 1
    else break
  }
  return { pc: mod12(base + offset), length: i - start }
}

/** Parses a complete note name (e.g. `F#`, `Bb`), or returns null. */
export function parseNote(input: string): PitchClass | null {
  const parsed = parseNoteAt(input.trim())
  return parsed && parsed.length === input.trim().length ? parsed.pc : null
}
