import { fc, test } from '@fast-check/vitest'
import { describe, expect, it } from 'vitest'

import { assignTab, tabGrid, tabToMusicXml, tabToText, type NoteIn } from '../src/tab.ts'
import { STANDARD } from '../src/tuning.ts'

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
    fc.array(fc.integer({ min: 30, max: 90 }), { maxLength: 40 }),
    fc.integer({ min: 0, max: 7 }),
  ])(
    'every placed note sounds its pitch, within reach, on distinct strings per event',
    (midis, capo) => {
      const notes = midis.map((midi, i) => ({ start: Math.floor(i / 3) * 0.5, end: 1, midi }))
      const result = assignTab(notes, { capo })
      expect(result.notes.length + result.unplayable.length).toBe(notes.length)
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
    expect(tabGrid(60, 1.5, 4)).toEqual({ step: 0.25, origin: 1.5, stepsPerBar: 16 })
    // A pickup half a bar before the downbeat gets its own bar.
    expect(tabGrid(60, 1.5, 4, -0.5).origin).toBe(-2.5)
    // Silence: the first note two bars after the downbeat starts the tab there.
    expect(tabGrid(60, 1.5, 4, 9.6).origin).toBe(9.5)
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
