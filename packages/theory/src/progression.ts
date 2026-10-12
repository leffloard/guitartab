/**
 * Chord progressions as they enter the engine: labels from a pasted chord sheet (no timing) or
 * from the analyzer (Harte labels with start/end times).
 */
import { chordKey, type Chord } from './chord.ts'
import { parseHarte } from './harte.ts'
import { parseChordSymbol } from './symbol.ts'

export interface ProgressionInput {
  label: string
  /** Seconds. Either all chord items have start and end, or the weighting is by occurrence. */
  start?: number
  end?: number
}

export type ParsedLabel =
  { kind: 'chord'; chord: Chord } | { kind: 'no-chord' } | { kind: 'invalid'; error: string }

const NO_CHORD = /^(?:N|X|N\.?C\.?|NC)$/i

/** Parses a chord label written either as a chord symbol (`Am7`) or in Harte syntax (`A:min7`). */
export function parseChordLabel(label: string): ParsedLabel {
  const text = label.trim()
  if (NO_CHORD.test(text)) return { kind: 'no-chord' }
  if (!text.includes(':')) {
    const symbol = parseChordSymbol(text)
    if (symbol.ok) return { kind: 'chord', chord: symbol.chord }
  }
  const harte = parseHarte(text)
  if (harte?.kind === 'chord') return harte
  if (harte?.kind === 'no-chord') return { kind: 'no-chord' }
  return { kind: 'invalid', error: `cannot parse chord "${label}"` }
}

export interface SymbolWeight {
  chord: Chord
  /** Share of the song this chord represents; all weights sum to 1. */
  weight: number
}

export interface WeightOptions {
  /** Timed segments shorter than this count only by duration, not as an occurrence. */
  minSegmentSec?: number
}

/**
 * Weight of each distinct chord. With timing: half by share of duration and half by share of
 * occurrences (changing to a hard chord thirty times is harder than holding it for thirty
 * seconds). Without timing: by occurrences. Repeated consecutive chords count once; no-chord
 * segments are ignored. Returned in first-appearance order.
 */
export function symbolWeights(
  chords: readonly { chord: Chord; start?: number | undefined; end?: number | undefined }[],
  options: WeightOptions = {},
): SymbolWeight[] {
  const { minSegmentSec = 0.25 } = options
  const timed =
    chords.length > 0 &&
    chords.every((c) => typeof c.start === 'number' && typeof c.end === 'number')
  const stats = new Map<string, { chord: Chord; duration: number; count: number }>()
  let previous: string | null = null
  for (const c of chords) {
    const key = chordKey(c.chord)
    const entry = stats.get(key) ?? { chord: c.chord, duration: 0, count: 0 }
    const duration = timed ? Math.max(0, (c.end ?? 0) - (c.start ?? 0)) : 0
    entry.duration += duration
    const countsAsOccurrence = !timed || duration >= minSegmentSec
    if (countsAsOccurrence && key !== previous) entry.count += 1
    if (countsAsOccurrence) previous = key
    stats.set(key, entry)
  }
  const totalDuration = [...stats.values()].reduce((s, e) => s + e.duration, 0)
  const totalCount = [...stats.values()].reduce((s, e) => s + e.count, 0)
  const useDuration = timed && totalDuration > 0
  const useCount = totalCount > 0
  return [...stats.values()].map((e) => {
    const byDuration = useDuration ? e.duration / totalDuration : 0
    const byCount = useCount ? e.count / totalCount : 0
    const weight =
      useDuration && useCount
        ? 0.5 * byDuration + 0.5 * byCount
        : useDuration
          ? byDuration
          : useCount
            ? byCount
            : 1 / stats.size
    return { chord: e.chord, weight }
  })
}
