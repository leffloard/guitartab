/**
 * The voicing library, indexed by chord root, plus a fretboard generator for chords the
 * library does not cover.
 */
import { STANDARD_LIBRARIES, type VoicingLibraryFile } from '@barrefree/voicings'

import { describe, type Chord } from './chord.ts'
import { mod12, type PitchClass } from './pitch.ts'
import { difficulty } from './score.ts'
import { tryParseChordSymbol } from './symbol.ts'
import { STANDARD } from './tuning.ts'
import {
  analyzeShape,
  assignFingers,
  makeVoicing,
  playedNotes,
  type Fret,
  type PlayedNotes,
  type ShapeInfo,
  type Voicing,
} from './voicing.ts'

export interface LibraryEntry {
  voicing: Voicing
  /** The chord name stored with the shape. */
  chord: Chord
  info: ShapeInfo
  /** Notes in standard tuning without capo ("shape space"). */
  played: PlayedNotes
}

export interface VoicingLibrary {
  /** Entries grouped by the root of their chord name. */
  byRoot: readonly (readonly LibraryEntry[])[]
  size: number
}

export function makeEntry(voicing: Voicing, chord: Chord): LibraryEntry {
  return {
    voicing,
    chord,
    info: analyzeShape(voicing),
    played: playedNotes(voicing.frets, STANDARD),
  }
}

/**
 * Builds a library from files in priority order. A shape (same frets) that appears twice keeps
 * the first file's name and fingering. Records whose chord name cannot be parsed, or that
 * cannot be fingered, are skipped (the data tests make sure none are).
 */
export function buildLibrary(files: readonly VoicingLibraryFile[]): VoicingLibrary {
  const buckets: LibraryEntry[][] = Array.from({ length: 12 }, () => [])
  const seen = new Set<string>()
  let size = 0
  for (const file of files) {
    for (const record of file.voicings) {
      const chord = tryParseChordSymbol(record.chord)
      if (!chord) continue
      const frets: Fret[] = record.frets
      const fingers = record.fingers ?? assignFingers(frets)
      if (!fingers) continue
      const voicing = makeVoicing(frets, fingers, file.source ? file.source.name : 'curated')
      const key = `${chord.root}|${voicing.id}`
      if (seen.has(key)) continue
      seen.add(key)
      buckets[chord.root]?.push(makeEntry(voicing, chord))
      size++
    }
  }
  return { byRoot: buckets, size }
}

let defaultLibrary: VoicingLibrary | undefined

/** The bundled standard-tuning library (curated shapes first, then chords-db). Memoized. */
export function getDefaultLibrary(): VoicingLibrary {
  defaultLibrary ??= buildLibrary(STANDARD_LIBRARIES)
  return defaultLibrary
}

// ---------------------------------------------------------------------------------------------
// Fretboard generator

export interface GenerateOptions {
  /** Highest fret (relative to the capo) a shape may use. */
  maxFret?: number
  /** Minimum number of sounding strings. */
  minStrings?: number
  /** Frets a hand can cover. */
  window?: number
  /** Maximum number of shapes returned (easiest first). */
  limit?: number
}

/**
 * Enumerates playable shapes for a chord when the library has none: every combination of
 * muted / open / fretted strings inside a four-fret window whose notes all belong to the
 * chord, with the correct lowest note, the root and the third present, and a fingering that
 * needs at most four fingers. Results are ordered by difficulty, then by id.
 */
export function generateVoicings(target: Chord, options: GenerateOptions = {}): LibraryEntry[] {
  const { maxFret = 12, minStrings = 4, window = 4, limit = 12 } = options
  const allowed = new Set<number>()
  const s = describe(target)
  for (let i = 0; i < 12; i++) if (target.intervals & (1 << i)) allowed.add(mod12(target.root + i))
  if (target.bass !== null) allowed.add(target.bass)
  const bass: PitchClass = target.bass ?? target.root
  const third =
    s.third === null ? null : mod12(target.root + { M3: 4, m3: 3, sus2: 2, sus4: 5 }[s.third])

  const found = new Map<string, LibraryEntry>()
  for (let low = 1; low <= maxFret; low++) {
    const options6: Fret[][] = STANDARD.midi.map((open) => {
      const opts: Fret[] = [null]
      if (allowed.has(mod12(open))) opts.push(0)
      for (let f = low; f < low + window && f <= maxFret; f++) {
        if (allowed.has(mod12(open + f))) opts.push(f)
      }
      return opts
    })
    const frets: Fret[] = []
    const walk = (string: number) => {
      if (string === 6) {
        const played = playedNotes(frets)
        if (played.pcs.length < minStrings || played.lowest !== bass) return
        const pcs = new Set<number>(played.pcs)
        if (!pcs.has(target.root) || (third !== null && !pcs.has(third))) return
        const fingers = assignFingers(frets)
        if (!fingers) return
        const voicing = makeVoicing([...frets], fingers, 'generated')
        if (!found.has(voicing.id)) found.set(voicing.id, makeEntry(voicing, target))
        return
      }
      for (const f of options6[string] ?? []) {
        frets.push(f)
        walk(string + 1)
        frets.pop()
      }
    }
    walk(0)
  }
  return [...found.values()]
    .map((e) => ({ e, d: difficulty(e.info).total }))
    .sort((a, b) => a.d - b.d || (a.e.voicing.id < b.e.voicing.id ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.e)
}
