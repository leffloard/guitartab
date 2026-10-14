import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'

import {
  assignTab,
  beatGrid,
  placeOnGrid,
  tabCost,
  tabGrid,
  tabToMusicXml,
  tabToText,
  type NoteIn,
  type TabNote,
} from '../src/tab.ts'
import { STANDARD } from '../src/tuning.ts'

/** Every way to put an event's pitches on distinct strings within reach. */
function placements(midis: readonly number[], capo = 0, maxFret = 5): [number, number][][] {
  const out: [number, number][][] = []
  const visit = (i: number, used: Set<number>, acc: [number, number][]) => {
    if (i === midis.length) {
      out.push([...acc])
      return
    }
    STANDARD.midi.forEach((base, s) => {
      const fret = (midis[i] ?? 0) - base - capo
      if (used.has(s) || fret < 0 || fret > maxFret) return
      visit(i + 1, new Set([...used, s]), [...acc, [s, fret]])
    })
  }
  visit(0, new Set(), [])
  return out
}

/** The lowest `tabCost` over every assignment of every event (small inputs only). */
function bruteForceCost(events: number[][]): number {
  let best = Infinity
  const walk = (t: number, chosen: TabNote[]) => {
    if (t === events.length) {
      best = Math.min(best, tabCost(chosen))
      return
    }
    const midis = events[t] ?? []
    for (const p of placements(midis)) {
      const notes = midis.map((midi, i) => ({
        start: t,
        end: t + 1,
        midi,
        string: p[i]?.[0] ?? 0,
        fret: p[i]?.[1] ?? 0,
      }))
      walk(t + 1, [...chosen, ...notes])
    }
  }
  walk(0, [])
  return best
}

const atOnce = (events: number[][]): NoteIn[] =>
  events.flatMap((midis, t) => midis.map((midi) => ({ start: t, end: t + 1, midi })))

const seq = (midis: number[], step = 0.3): NoteIn[] =>
  midis.map((midi, i) => ({ start: i * step, end: (i + 1) * step, midi }))

describe('tab assignment', () => {
  it('plays a C major arpeggio on the open C shape', () => {
    const { notes, unplayable } = assignTab(seq([48, 52, 55, 60, 64, 60, 55, 52]))
    expect(unplayable).toEqual([])
    // [string, fret]: A3, D2, G0, B1, e0: the chord shape every beginner knows.
    expect(notes.map((n) => [n.string, n.fret])).toEqual([
      [1, 3],
      [2, 2],
      [3, 0],
      [4, 1],
      [5, 0],
      [4, 1],
      [3, 0],
      [2, 2],
    ])
  })

  it('counts frets from the capo and puts chord notes on distinct strings', () => {
    // A C chord sounding with capo 3 is played as an A shape (x02220 relative to the capo).
    const chord: NoteIn[] = [48, 55, 60, 64].map((midi) => ({ start: 0, end: 1, midi }))
    const { notes } = assignTab(chord, { capo: 3 })
    expect(new Set(notes.map((n) => n.string)).size).toBe(4)
    for (const n of notes) expect(n.fret).toBe(n.midi - (STANDARD.midi[n.string] ?? 0) - 3)
    expect(notes.map((n) => n.fret)).toEqual([0, 2, 2, 2])
  })

  it('reports notes out of reach instead of forcing them onto the neck', () => {
    const { notes, unplayable } = assignTab(seq([38, 52, 76]))
    expect(notes.map((n) => n.midi)).toEqual([52])
    expect(unplayable.map((n) => n.midi)).toEqual([38, 76])
    // Seven notes at once: at most six strings.
    const seven = [40, 45, 50, 55, 59, 64, 52].map((midi) => ({ start: 0, end: 1, midi }))
    const crowded = assignTab(seven)
    expect(crowded.notes).toHaveLength(6)
    expect(crowded.unplayable).toHaveLength(1)
  })

  it('keeps the most chord tones when a group has more notes than strings', () => {
    // An open E chord plus a stray A2: one note goes, six stay (dropping the middle notes
    // first used to cost a second chord tone).
    const e = assignTab(atOnce([[40, 45, 47, 52, 56, 59, 64]]))
    expect(e.notes).toHaveLength(6)
    expect(e.unplayable).toHaveLength(1)
    const g = assignTab(atOnce([[40, 43, 47, 50, 55, 59, 67]]))
    expect(g.notes).toHaveLength(6)
    expect(g.unplayable).toHaveLength(1)
  })

  it('finds the cheapest tab even when open strings carry the hand position', () => {
    // C4, open A, A4: the hand stays at fret 5 over the open A (no 5th-fret bass note).
    const pieces = [
      [[60], [45], [69]],
      [[60], [45], [50], [69]],
      [[60], [45], [45], [69]],
    ]
    for (const midis of pieces) {
      const { notes } = assignTab(atOnce(midis))
      expect(tabCost(notes)).toBeCloseTo(bruteForceCost(midis), 9)
    }
  })

  test.prop([
    fc.array(
      fc
        .array(fc.integer({ min: 40, max: 69 }), { minLength: 1, maxLength: 2 })
        .map((m) => [...new Set(m)])
        .filter((m) => placements(m).length > 0),
      { minLength: 1, maxLength: 4 },
    ),
  ])('matches a brute-force optimum on small pieces', (events) => {
    const { notes, unplayable } = assignTab(atOnce(events))
    expect(unplayable).toEqual([])
    expect(tabCost(notes)).toBeCloseTo(bruteForceCost(events), 9)
  })

  it('weighs hand movement and stretch as documented', () => {
    // Movement: after C#3 on A4, C4 stays at fret 5 (G string) rather than B1 four frets away.
    expect(assignTab(seq([49, 60])).notes.map((n) => [n.string, n.fret])).toEqual([
      [1, 4],
      [3, 5],
    ])
    // Stretch: F2 + B3 + C4 as E1 G4 B1 (a 3-fret span), not E1 B0 G5 (four frets).
    const chord = assignTab(atOnce([[41, 59, 60]])).notes
    expect(chord.map((n) => [n.string, n.fret])).toEqual([
      [0, 1],
      [3, 4],
      [4, 1],
    ])
  })

  it('stays in position rather than jumping around the neck', () => {
    // E4 (64) can be open e or B string fret 5. After B-string notes at frets 3-5 the hand is
    // already there; alone, the open string is cheaper.
    const inPosition = assignTab(seq([62, 63, 64]), { maxFret: 7 })
    expect(inPosition.notes.map((n) => [n.string, n.fret])).toEqual([
      [4, 3],
      [4, 4],
      [5, 0],
    ])
  })

  test.prop([
    fc.array(fc.array(fc.integer({ min: 30, max: 90 }), { minLength: 1, maxLength: 8 }), {
      maxLength: 12,
    }),
    fc.integer({ min: 0, max: 7 }),
  ])(
    'every placed note sounds its pitch, within reach, on distinct strings per event',
    (groups, capo) => {
      // Notes of a group start within a few milliseconds of each other.
      const notes = groups.flatMap((midis, t) =>
        midis.map((midi, i) => ({ start: t * 0.5 + i * 0.003, end: t * 0.5 + 0.4, midi })),
      )
      const result = assignTab(notes, { capo })
      expect(result.notes.length + result.unplayable.length).toBe(notes.length)
      // Nothing left out could have been placed: each group keeps the most notes that fit.
      groups.forEach((midis, t) => {
        const placed = result.notes.filter((n) => Math.round(n.start / 0.5) === t).length
        let most = 0
        const pick = (i: number, chosen: number[]) => {
          if (i === midis.length) {
            if (chosen.length > most && placements(chosen, capo).length > 0) most = chosen.length
            return
          }
          pick(i + 1, [...chosen, midis[i] ?? 0])
          pick(i + 1, chosen)
        }
        pick(0, [])
        expect(placed).toBe(most)
      })
      const byStart = new Map<number, Set<number>>()
      for (const n of result.notes) {
        expect(n.fret).toBeGreaterThanOrEqual(0)
        expect(n.fret).toBeLessThanOrEqual(5)
        expect((STANDARD.midi[n.string] ?? 0) + capo + n.fret).toBe(n.midi)
        const strings = byStart.get(n.start) ?? new Set<number>()
        expect(strings.has(n.string)).toBe(false)
        strings.add(n.string)
        byStart.set(n.start, strings)
      }
    },
  )
})

describe('text tab', () => {
  it('writes one column per sixteenth, high e on top', () => {
    const { notes } = assignTab(seq([48, 52, 55, 60], 0.125))
    // 120 bpm: a sixteenth is 0.125 s.
    expect(tabToText(notes, tabGrid(120, 0, 1))).toBe(
      [
        'e|--------|',
        'B|------1-|',
        'G|----0---|',
        'D|--2-----|',
        'A|3-------|',
        'E|--------|',
        '',
      ].join('\n'),
    )
    expect(tabToText([], tabGrid(120))).toBe('')
  })

  it('starts the grid at the bar line of the bar holding the first note', () => {
    const grid = tabGrid(60, 1.5, 4)
    expect(grid.stepsPerBar).toBe(16)
    expect([1.5, 1.75, 2.5].map(grid.slot)).toEqual([0, 1, 4])
    // A pickup half a bar before the downbeat gets its own bar.
    expect(tabGrid(60, 1.5, 4, -0.5).slot(-0.5)).toBe(8)
    // Silence: the first note two bars after the downbeat starts the tab there.
    expect(tabGrid(60, 1.5, 4, 9.6).slot(9.5)).toBe(0)
  })

  it('follows the detected beats when the tempo drifts', () => {
    // A recording that slows from 120 to about 100 bpm over 64 beats.
    const beats: number[] = [0.3]
    for (let i = 1; i < 64; i++) beats.push((beats[i - 1] ?? 0) + 0.5 + i * 0.0015)
    const grid = beatGrid(beats, [0.3], 4)
    expect(grid).not.toBeNull()
    // Every beat lands on a quarter of the grid, every fourth on a bar line.
    beats.forEach((b, i) => expect(grid?.slot(b)).toBe(i * 4))
    // Halfway between two beats is the eighth after the first.
    expect(grid?.slot(((beats[40] ?? 0) + (beats[41] ?? 0)) / 2)).toBe(162)
    // One fixed tempo has drifted by then.
    const fixed = tabGrid(120, 0.3, 4)
    expect(fixed.slot(beats[40] ?? 0)).not.toBe(160)
    // Before the first beat the first interval is extended: a pickup gets its own bar.
    const pickup = beatGrid(beats, [0.3], 4, 0.05)
    expect(pickup?.slot(0.3)).toBe(16)
    expect(beatGrid([1], [1])).toBeNull()
  })

  it('moves a note to the next sixteenth when its string is taken, and reports the rest', () => {
    // A hammer-on: open D, then D fret 2, 60 ms apart at 120 bpm (a sixteenth is 125 ms).
    const note = (start: number, fret: number): TabNote => ({
      start,
      end: start + 0.1,
      midi: 50 + fret,
      string: 2,
      fret,
    })
    const grid = tabGrid(120, 0, 1)
    const { placed, crowded } = placeOnGrid([note(0, 0), note(0.06, 2), note(0.02, 4)], grid)
    // In time order: 0 at its sixteenth, 4 moved to the next one, 2 has no room left.
    expect(placed.map((p) => [p.note.fret, p.slot])).toEqual([
      [0, 0],
      [4, 1],
    ])
    expect(crowded.map((n) => n.fret)).toEqual([2])
    // Text and MusicXML show the same notes.
    expect(tabToText([note(0, 0), note(0.06, 2)], grid).split('\n')[3]).toBe('D|0-2-----|')
    const xml = tabToMusicXml([note(0, 0), note(0.06, 2)], grid)
    expect([...xml.matchAll(/<fret>(\d+)<\/fret>/g)].map((m) => m[1])).toEqual(['0', '2'])
  })
})

describe('MusicXML tab', () => {
  const sixteenths = (xml: string) =>
    [...xml.matchAll(/<measure number="(\d+)">(.*?)<\/measure>/g)].map(([, , body]) =>
      // Chord members share the first note's time.
      [...(body ?? '').matchAll(/<note>(<chord\/>)?.*?<duration>(\d+)<\/duration>/g)]
        .filter((m) => !m[1])
        .reduce((sum, m) => sum + Number(m[2]), 0),
    )

  it('fills every bar exactly, with string and fret on each note', () => {
    const { notes } = assignTab(seq([48, 52, 55, 60, 64], 0.375))
    const xml = tabToMusicXml(notes, tabGrid(120, 0, 2), { title: 'Arpeggio <test>', capo: 2 })
    expect(xml).toContain('<work-title>Arpeggio &#60;test&#62;</work-title>')
    // Characters XML forbids (a file name may hold them) are dropped, not written.
    expect(tabToMusicXml(notes, tabGrid(120), { title: 'a\u0001b\uFFFEc\uD800d' })).toContain(
      '<work-title>abcd</work-title>',
    )
    expect(xml).toContain('<capo>2</capo>')
    expect(xml).toContain('<sign>TAB</sign>')
    // C3 on the A string (MusicXML string 5), fret 3.
    expect(xml).toContain(
      '<pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>1</voice><type>eighth</type><dot/>',
    )
    expect(xml).toContain('<technical><string>5</string><fret>3</fret></technical>')
    expect(sixteenths(xml)).toEqual([8, 8])
    // Tags are balanced.
    const opened = [...xml.matchAll(/<([a-z-]+)[^>/]*>/g)].length
    const closed = [...xml.matchAll(/<\/([a-z-]+)>/g)].length
    expect(opened).toBe(closed)
  })

  it('writes rests and ties (as <tied>, which alphaTab reads) over several bar lines', () => {
    const on = (start: number, fret: number): TabNote => ({
      start,
      end: start + 0.2,
      midi: 50 + fret,
      string: 2,
      fret,
    })
    // 60 bpm in 4/4: a sixteenth is 0.25 s, a bar 4 s. The open D at 3 s rings until 9 s.
    const xml = tabToMusicXml([on(1.25, 2), on(3, 0), on(9, 1)], tabGrid(60, 0, 4))
    const bars = [...xml.matchAll(/<measure number="\d+">(.*?)<\/measure>/g)].map(([, body]) =>
      [...(body ?? '').matchAll(/<note>(.*?)<\/note>/g)]
        .map(([, note]) => {
          const what = note?.includes('<rest/>')
            ? 'R'
            : (/<fret>(\d+)/.exec(note ?? '')?.[1] ?? '?')
          const length = /<duration>(\d+)/.exec(note ?? '')?.[1]
          const tied = [...(note ?? '').matchAll(/<tied type="(\w+)"\/>/g)].map((m) => m[1])
          return `${what}:${length}${tied.length ? `(${tied.join('+')})` : ''}`
        })
        .join(' '),
    )
    expect(bars).toEqual([
      'R:4 R:1 2:6(start) 2:1(stop) 0:4(start)',
      '0:16(stop+start)',
      '0:4(stop) 1:12',
    ])
  })

  it('ties a note held across a bar line and writes chords with <chord/>', () => {
    const notes = assignTab([
      { start: 0, end: 1, midi: 48 },
      { start: 0, end: 1, midi: 52 },
      { start: 0.75, end: 2, midi: 55 },
      { start: 1.5, end: 2, midi: 60 },
    ]).notes
    const xml = tabToMusicXml(notes, tabGrid(60, 0, 1))
    expect(xml.match(/<chord\/>/g)).toHaveLength(1)
    expect(xml).toContain('<tie type="start"/>')
    expect(xml).toContain('<tie type="stop"/>')
    expect(sixteenths(xml)).toEqual([4, 4])
  })
})
