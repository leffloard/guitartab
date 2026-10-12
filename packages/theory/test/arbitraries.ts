import fc from 'fast-check'

import { makeChord, type Chord } from '../src/chord.ts'
import type { PitchClass } from '../src/pitch.ts'

export const pitchClass = fc.integer({ min: 0, max: 11 }).map((n) => n as PitchClass)

/** Any interval set over a root (all 2048 masks are reachable). */
export const anyChord: fc.Arbitrary<Chord> = fc
  .record({
    root: pitchClass,
    mask: fc.integer({ min: 0, max: 0xfff }),
    bass: fc.option(pitchClass, { nil: null }),
  })
  .map(({ root, mask, bass }) => makeChord(root, mask, bass))

/** Chord symbols a chord sheet would realistically contain. */
export const COMMON_SUFFIXES = [
  '',
  'm',
  '7',
  'maj7',
  'm7',
  'sus4',
  'sus2',
  'add9',
  '6',
  'm6',
  '9',
  'dim',
  'dim7',
  'm7b5',
  'aug',
  '7sus4',
  '5',
] as const
const ROOT_NAMES = ['C', 'C#', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B']

export const commonSymbol: fc.Arbitrary<string> = fc
  .record({
    root: fc.constantFrom(...ROOT_NAMES),
    suffix: fc.constantFrom(...COMMON_SUFFIXES),
    bass: fc.option(fc.constantFrom(...ROOT_NAMES), { nil: null, freq: 6 }),
  })
  .map(({ root, suffix, bass }) => `${root}${suffix}${bass ? `/${bass}` : ''}`)

/** Triads and sevenths without slash: the bread and butter of pop songs. */
export const simpleSymbol: fc.Arbitrary<string> = fc
  .record({
    root: fc.constantFrom(...ROOT_NAMES),
    suffix: fc.constantFrom('', 'm', '7', 'm7', 'maj7', 'sus4', 'sus2'),
  })
  .map(({ root, suffix }) => root + suffix)
