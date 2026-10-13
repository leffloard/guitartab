import { describe, expect, it } from 'vitest'

import {
  barsFromBeats,
  beatsBetween,
  chartToChordPro,
  chartToText,
  chordIndexAt,
  layoutBars,
  trimEmptyBars,
  nextChordIndex,
  type TimedChord,
} from '../src/timeline.ts'

const beats = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]
const downbeats = [0.5, 2.5, 4.5]
const chords: TimedChord[] = [
  { start: 0, end: 0.5, label: 'N' },
  { start: 0.5, end: 2.5, label: 'C:maj' },
  { start: 2.5, end: 3.5, label: 'G:maj' },
  { start: 3.5, end: 6.5, label: 'A:min' },
  { start: 6.5, end: 7, label: 'N' },
]

describe('timeline', () => {
  it('finds the chord sounding at a time', () => {
    expect([0, 0.49, 0.5, 2.4, 2.5, 6.9, 7, 99, -1].map((t) => chordIndexAt(chords, t))).toEqual([
      0, 0, 1, 1, 2, 4, -1, -1, -1,
    ])
    expect(
      chordIndexAt(
        [
          { start: 0, end: 1 },
          { start: 2, end: 3 },
        ],
        1.5,
      ),
    ).toBe(-1)
  })

  it('finds the next real change and counts beats to it', () => {
    expect(nextChordIndex(chords, 0.1)).toBe(1)
    expect(nextChordIndex(chords, 1.0)).toBe(2)
    expect(nextChordIndex(chords, 4.0)).toBe(-1) // only N follows
    expect(beatsBetween(beats, 1.0, 2.5)).toBe(3)
    expect(beatsBetween(beats, 2.45, 2.5)).toBe(0)
  })

  it('builds bars from downbeats with a pickup bar', () => {
    const bars = barsFromBeats(beats, downbeats, 7)
    expect(bars.map((b) => [b.start, b.end, b.beats.length])).toEqual([
      [0, 0.5, 0],
      [0.5, 2.5, 4],
      [2.5, 4.5, 4],
      [4.5, 7, 4],
    ])
    expect(barsFromBeats(beats, [], 7, 3).map((b) => b.start)).toEqual([0, 0.5, 2, 3.5, 5])
    expect(barsFromBeats([], [], 7)).toEqual([{ start: 0, end: 7, beats: [] }])
  })

  it('trims empty bars around the music', () => {
    const bars = layoutBars(barsFromBeats(beats, downbeats, 9), chords)
    // The lead-in and the tail are rests: kept in the bars, but they do not count as music.
    expect(bars.map((b) => b.chords.length)).toEqual([1, 1, 2, 2])
    expect(trimEmptyBars(bars).map((b) => b.start)).toEqual([0.5, 2.5, 4.5])
    expect(trimEmptyBars(layoutBars(bars, [{ start: 0, end: 9, label: 'N' }]))).toEqual([])
    // A rest the caller wants kept (a user's fix) keeps its bar.
    expect(trimEmptyBars(bars, (i) => i === 0).map((b) => b.start)).toEqual([0, 0.5, 2.5, 4.5])
  })

  it('lays chords on beats and writes text and ChordPro charts', () => {
    const bars = layoutBars(barsFromBeats(beats, downbeats, 7).slice(1), chords)
    expect(bars.map((b) => b.chords)).toEqual([
      [{ index: 1, beat: 0, carried: false, rest: false }],
      [
        { index: 2, beat: 0, carried: false, rest: false },
        { index: 3, beat: 2, carried: false, rest: false },
      ],
      [
        { index: 3, beat: 0, carried: true, rest: false },
        { index: 4, beat: 3, carried: false, rest: true },
      ],
    ])
    const name = (i: number) => ({ 1: 'C', 2: 'G', 3: 'Am' })[i] ?? '?'
    // A break is written N.C.: a dot would mean "keep playing Am".
    expect(chartToText(bars, name)).toBe('| C . . . | G . Am . | . . . N.C. |')
    // A line that starts inside a held chord names it.
    expect(chartToText(bars, name, { barsPerLine: 2 })).toBe(
      '| C . . . | G . Am . |\n| Am . . N.C. |',
    )
    expect(chartToChordPro(bars, name, { title: 'Song', capo: 2, tempo: 119.6, time: '4/4' })).toBe(
      '{title: Song}\n{capo: 2}\n{tempo: 120}\n{time: 4/4}\n| [C] . . . | [G] . [Am] . | . . . [N.C.] |\n',
    )
  })

  it('never drops a chord: bars without beats and beat grids that stop early', () => {
    const four: TimedChord[] = [
      { start: 0, end: 2, label: 'C:maj' },
      { start: 2, end: 4, label: 'G:maj' },
      { start: 4, end: 6, label: 'A:min' },
      { start: 6, end: 8, label: 'F:maj' },
    ]
    const name = (i: number) => ['C', 'G', 'Am', 'F'][i] ?? '?'
    // No beat grid at all: one bar, chords placed by their share of it.
    const noBeats = layoutBars(barsFromBeats([], [], 8), four)
    expect(noBeats[0]?.chords.map((c) => c.beat)).toEqual([0, 1, 2, 3])
    expect(chartToText(noBeats, name)).toBe('| C G Am F |')
    // The beats stop after 3.5 s: later chords crowd the last beats but all stay, in order.
    const early = layoutBars(barsFromBeats([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5], [0, 2], 8), four)
    expect(chartToText(early, name)).toBe('| C . . . | G . Am F |')
    // More chords than slots: the first slot is shared.
    const crowded = layoutBars([{ start: 0, end: 8, beats: [0, 4] }], four)
    expect(chartToText(crowded, name)).toBe('| C G Am F |')
  })
})
