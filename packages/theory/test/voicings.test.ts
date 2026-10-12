import { STANDARD_LIBRARIES } from '@barrefree/voicings'
import { test } from '@fast-check/vitest'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { describe as describeChord, pitchClassesOf, transpose } from '../src/chord.ts'
import { buildLibrary, generateVoicings, getDefaultLibrary, makeEntry } from '../src/library.ts'
import { mod12 } from '../src/pitch.ts'
import { clashes, difficulty, fidelity, realizes } from '../src/score.ts'
import { tryParseChordSymbol } from '../src/symbol.ts'
import { EB_STANDARD, STANDARD, uniformShift } from '../src/tuning.ts'
import {
  analyzeShape,
  assignFingers,
  findBarres,
  makeVoicing,
  playedNotes,
  soundingMidi,
  voicingId,
  type Finger,
  type Fret,
} from '../src/voicing.ts'

const x = null

function chord(text: string) {
  const c = tryParseChordSymbol(text)
  if (!c) throw new Error(text)
  return c
}

function shape(frets: Fret[], fingers: Finger[]) {
  return makeEntry(makeVoicing(frets, fingers, 'test'), chord('C'))
}

describe('shape analysis', () => {
  it('derives ids, sounding notes and played pitch classes', () => {
    expect(voicingId([x, x, 3, 2, 1, 0])).toBe('x-x-3-2-1-0')
    expect(soundingMidi([x, 3, 2, 0, 1, 0])).toEqual([null, 48, 52, 55, 60, 64])
    expect(soundingMidi([0, 0, 0, 0, 0, 0], EB_STANDARD, 2)).toEqual([41, 46, 51, 56, 60, 65])
    expect(playedNotes([x, 3, 2, 0, 1, 0])).toEqual({ pcs: [0, 4, 7, 0, 4], lowest: 0 })
    expect(playedNotes([x, x, x, x, x, x])).toEqual({ pcs: [], lowest: 0 })
  })

  it('finds full and mini barres from the fingering', () => {
    expect(findBarres([1, 3, 3, 2, 1, 1], [1, 3, 4, 2, 1, 1])).toEqual([
      { fret: 1, from: 0, to: 5, strings: 6, full: true },
    ])
    expect(findBarres([x, x, 3, 2, 1, 1], [x, x, 3, 2, 1, 1])).toEqual([
      { fret: 1, from: 4, to: 5, strings: 2, full: false },
    ])
    expect(findBarres([x, 0, 2, 2, 2, 0], [x, x, 1, 2, 3, x])).toEqual([])
  })

  it('measures span, position, muted and open strings', () => {
    const info = analyzeShape({ frets: [x, 2, x, 2, 3, 0], fingers: [x, 1, x, 2, 3, x] })
    expect(info).toMatchObject({
      sounding: 4,
      lowest: 1,
      highest: 5,
      minFret: 2,
      maxFret: 3,
      span: 1,
      fingersUsed: 3,
      mutedInner: 1,
      mutedTreble: 0,
      openAboveBass: 1,
    })
    expect(
      analyzeShape({ frets: [0, 2, 2, 1, 0, x], fingers: [x, x, x, x, x, x] }).fingersUsed,
    ).toBe(3)
    expect(analyzeShape({ frets: [0, 0, 0, 0, 0, 0], fingers: [x, x, x, x, x, x] }).span).toBe(0)
  })

  it('assigns fingers, using a barre only when more than four strings are fretted', () => {
    expect(assignFingers([x, 0, 2, 2, 2, 0])).toEqual([x, x, 1, 2, 3, x])
    expect(assignFingers([1, 3, 3, 2, 1, 1])).toEqual([1, 3, 4, 2, 1, 1])
    expect(assignFingers([x, 2, 4, 4, 4, 2])).toEqual([x, 1, 2, 3, 4, 1])
    expect(assignFingers([0, 0, 0, 0, 0, 0])).toEqual([x, x, x, x, x, x])
    // An open string under the barre is impossible.
    expect(assignFingers([1, 3, 0, 2, 1, 1])).toBeNull()
    // Five notes above the barre fret need five fingers.
    expect(assignFingers([1, 2, 3, 4, 3, 2])).toBeNull()
  })

  test.prop([
    fc.array(fc.option(fc.integer({ min: 0, max: 12 }), { nil: null }), {
      minLength: 6,
      maxLength: 6,
    }),
  ])('assigned fingerings are physically consistent', (frets) => {
    const fingers = assignFingers(frets)
    if (!fingers) return
    const fretOf = new Map<number, number>()
    frets.forEach((f, i) => {
      const finger = fingers[i]
      if (f === null || f === 0) expect(finger).toBeNull()
      else {
        expect(finger).toBeGreaterThanOrEqual(1)
        expect(finger).toBeLessThanOrEqual(4)
        expect(fretOf.get(finger ?? 0) ?? f).toBe(f)
        fretOf.set(finger ?? 0, f)
      }
    })
  })

  test.prop([
    fc.array(fc.option(fc.integer({ min: 0, max: 12 }), { nil: null }), {
      minLength: 6,
      maxLength: 6,
    }),
    fc.integer({ min: 0, max: 7 }),
  ])('a capo transposes the played pitch classes', (frets, capo) => {
    const open = playedNotes(frets)
    const withCapo = playedNotes(frets, STANDARD, capo)
    expect(withCapo.pcs).toEqual(open.pcs.map((pc) => mod12(pc + capo)))
  })

  it('knows which tunings are uniform shifts', () => {
    expect(uniformShift(STANDARD)).toBe(0)
    expect(uniformShift(EB_STANDARD)).toBe(-1)
    expect(uniformShift({ id: 'drop-d', midi: [38, 45, 50, 55, 59, 64] })).toBeNull()
  })
})

describe('voicing library data', () => {
  const records = STANDARD_LIBRARIES.flatMap((file) => file.voicings)

  it('every chord name parses', () => {
    const bad = records.filter((r) => tryParseChordSymbol(r.chord) === null).map((r) => r.chord)
    expect(bad).toEqual([])
  })

  it('every shape plays only notes of its chord, with root, third and the right bass', () => {
    const problems: string[] = []
    for (const r of records) {
      const c = chord(r.chord)
      const played = playedNotes(r.frets)
      const allowed = new Set<number>(pitchClassesOf(c))
      if (c.bass !== null) allowed.add(c.bass)
      const { third } = describeChord(c)
      const thirdPc =
        third === null ? null : mod12(c.root + { M3: 4, m3: 3, sus2: 2, sus4: 5 }[third])
      const pcs = new Set<number>(played.pcs)
      if (![...pcs].every((pc) => allowed.has(pc)))
        problems.push(`${r.chord} ${String(r.frets)}: foreign note`)
      if (!pcs.has(c.root)) problems.push(`${r.chord} ${String(r.frets)}: no root`)
      if (thirdPc !== null && !pcs.has(thirdPc))
        problems.push(`${r.chord} ${String(r.frets)}: no third`)
      if (c.bass !== null && played.lowest !== c.bass)
        problems.push(`${r.chord} ${String(r.frets)}: bass`)
      if (played.pcs.length < 3) problems.push(`${r.chord} ${String(r.frets)}: < 3 strings`)
    }
    expect(problems).toEqual([])
  })

  it('every fingering puts each finger on a single fret and only on fretted strings', () => {
    const problems: string[] = []
    for (const r of records) {
      if (!r.fingers) continue
      const fretOf = new Map<number, number>()
      r.fingers.forEach((finger, i) => {
        const fret = r.frets[i]
        if (finger === null || finger === undefined) return
        if (fret === null || fret === undefined || fret === 0)
          problems.push(`${r.chord}: finger on open/muted`)
        else if ((fretOf.get(finger) ?? fret) !== fret)
          problems.push(`${r.chord} ${String(r.frets)}: finger ${finger}`)
        else fretOf.set(finger, fret)
      })
    }
    expect(problems).toEqual([])
  })

  it('builds an index by root covering all twelve roots', () => {
    const lib = getDefaultLibrary()
    expect(getDefaultLibrary()).toBe(lib)
    expect(lib.size).toBeGreaterThan(2500)
    lib.byRoot.forEach((bucket, root) => {
      expect(bucket.length).toBeGreaterThan(50)
      for (const e of bucket) expect(e.chord.root).toBe(root)
    })
  })

  it('lets earlier files win for duplicate shapes and skips unusable records', () => {
    const lib = buildLibrary([
      {
        tuning: 'standard',
        voicings: [{ chord: 'C', frets: [x, 3, 2, 0, 1, 0], fingers: [x, 3, 2, x, 1, x] }],
      },
      {
        tuning: 'standard',
        source: { name: 'other', url: '', commit: '0'.repeat(40), license: 'MIT' },
        voicings: [
          { chord: 'C', frets: [x, 3, 2, 0, 1, 0], fingers: [x, 4, 3, x, 2, x] },
          { chord: 'not a chord', frets: [x, 3, 2, 0, 1, 0] },
          { chord: 'C', frets: [1, 3, 0, 2, 1, 1] }, // cannot be fingered
          { chord: 'C', frets: [x, 3, 5, 5, 5, 3] }, // fingers derived automatically
        ],
      },
    ])
    expect(lib.size).toBe(2)
    expect(lib.byRoot[0]?.[0]?.voicing.fingers).toEqual([x, 3, 2, x, 1, x])
    expect(lib.byRoot[0]?.[0]?.voicing.source).toBe('curated')
    expect(lib.byRoot[0]?.[1]?.voicing).toMatchObject({
      source: 'other',
      fingers: [x, 1, 2, 3, 4, 1],
    })
  })
})

describe('difficulty and fidelity: the F example from the design', () => {
  const F = chord('F')
  const cases = [
    { name: 'F barre', frets: [1, 3, 3, 2, 1, 1], fingers: [1, 3, 4, 2, 1, 1], d: 9.0, f: 1 },
    { name: 'small F', frets: [x, x, 3, 2, 1, 1], fingers: [x, x, 3, 2, 1, 1], d: 4.5, f: 1 },
    {
      name: 'Fmaj7',
      frets: [x, x, 3, 2, 1, 0],
      fingers: [x, x, 3, 2, 1, x],
      d: 2.1,
      f: 1 - 0.8 / 7,
    },
    {
      name: '3-string F',
      frets: [x, x, x, 2, 1, 1],
      fingers: [x, x, x, 2, 1, 1],
      d: 4.0,
      f: 1 - 1 / 7,
    },
  ] as const

  it.each(cases)('$name: difficulty $d, fidelity $f', ({ frets, fingers, d, f }) => {
    const e = shape([...frets], [...fingers])
    expect(difficulty(e.info).total).toBeCloseTo(d, 10)
    expect(fidelity(F, e.played).value).toBeCloseTo(f, 10)
  })

  it('Fmaj7 wins at λ = 10, the small F only from λ ≈ 21', () => {
    const cost = (i: number, lambda: number) => {
      const c = cases[i]
      if (!c) throw new Error('case')
      const e = shape([...c.frets], [...c.fingers])
      return difficulty(e.info).total + lambda * (1 - fidelity(F, e.played).value)
    }
    expect(cost(2, 10)).toBeLessThan(cost(1, 10))
    expect(cost(2, 20)).toBeLessThan(cost(1, 20))
    expect(cost(1, 40)).toBeLessThan(cost(2, 40))
  })

  it('breaks the difficulty down into its terms', () => {
    const e = shape([1, 3, 3, 2, 1, 1], [1, 3, 4, 2, 1, 1])
    expect(difficulty(e.info).parts).toEqual({
      base: 100,
      barre: 600,
      fingers: 200,
      span: 0,
      position: 0,
      mutedInner: 0,
      mutedTreble: 0,
      openStrings: 0,
    })
    const high = shape([x, 7, 9, 9, 9, 7], [x, 1, 2, 3, 4, 1])
    expect(difficulty(high.info).parts.position).toBe(180)
    const wide = shape([x, 1, 5, 2, 1, x], [x, 1, 4, 2, 1, x])
    expect(difficulty(wide.info).parts).toMatchObject({ span: 200, mutedTreble: 50 })
  })

  it('does not reward a wrong-bass inversion with its extra open string', () => {
    const C = chord('C')
    const rootPosition = shape([x, 3, 2, 0, 1, 0], [x, 3, 2, x, 1, x])
    const inversion = shape([0, 3, 2, 0, 1, 0], [x, 3, 2, x, 1, x])
    const cost = (e: typeof rootPosition) =>
      difficulty(e.info).total + 10 * (1 - fidelity(C, e.played).value)
    expect(difficulty(inversion.info).total).toBe(difficulty(rootPosition.info).total)
    expect(cost(rootPosition)).toBeLessThan(cost(inversion))
  })
})

describe('fidelity details', () => {
  const play = (frets: Fret[]) => playedNotes(frets)

  it('reports missing and added tones, clashes and bass', () => {
    const r = fidelity(chord('C7'), play([x, 3, 2, 0, 1, 0]))
    expect(r.missing).toEqual([10])
    expect(r.added).toEqual([])
    expect(r.bassOk).toBe(true)

    const minorForMajor = fidelity(chord('C'), play([x, 3, 1, 0, 1, x]))
    expect(minorForMajor.clash).toBe(true)
    expect(minorForMajor.value).toBe(0)

    expect(fidelity(chord('C/E'), play([x, 3, 2, 0, 1, 0])).bassOk).toBe(false)
  })

  it('classifies clashes', () => {
    expect(clashes(chord('C'), 3)).toBe(true)
    expect(clashes(chord('Cm'), 4)).toBe(true)
    expect(clashes(chord('Csus4'), 4)).toBe(true)
    expect(clashes(chord('C7'), 11)).toBe(true)
    expect(clashes(chord('Cmaj7'), 10)).toBe(true)
    expect(clashes(chord('Cdim'), 7)).toBe(true)
    expect(clashes(chord('C'), 11)).toBe(false) // F → Fmaj7 is the classic substitute
    expect(clashes(chord('Cm'), 2)).toBe(false) // Cm(add9) is fine
    expect(clashes(chord('C5'), 4)).toBe(false)
  })

  it('penalizes each kind of added tone', () => {
    const value = (target: string, frets: Fret[]) => fidelity(chord(target), play(frets)).value
    // C5 shapes: an added third is a mild colour
    expect(value('C5', [x, 3, 2, 0, x, x])).toBeCloseTo(1 - 0.5 / 6, 10)
    // C(no5) plus a fifth
    expect(value('Cno5', [x, 3, 2, 0, 1, 0])).toBeCloseTo(1 - 0.2 / 6, 10)
    // an added fourth (F on the high E string)
    expect(value('C', [x, 3, 2, 0, 1, 1])).toBeCloseTo(1 - 1 / 7, 10)
    // C with an added b9 (Db)
    expect(value('C', [x, 3, 2, 0, 2, 0])).toBeCloseTo(1 - 2 / 7, 10)
    // an added sixth (A on the G string), fifth kept on the high E string
    expect(value('C', [x, 3, 2, 2, 1, 3])).toBeCloseTo(1 - 1 / 7, 10)
  })

  it('realizes() accepts exact voicings and rejects substitutes', () => {
    expect(realizes(chord('C7'), play([x, 3, 2, 3, 1, 0]))).toBe(true)
    expect(realizes(chord('F'), play([x, x, 3, 2, 1, 1]))).toBe(true)
    expect(realizes(chord('F'), play([x, x, 3, 2, 1, 0]))).toBe(false) // Fmaj7 adds E
    expect(realizes(chord('C'), play([0, 3, 2, 0, 1, 0]))).toBe(false) // E in the bass
    expect(realizes(chord('C/E'), play([0, 3, 2, 0, 1, 0]))).toBe(true)
    expect(realizes(chord('C9'), play([x, 3, 2, 3, 3, 0]))).toBe(true)
    expect(realizes(chord('C9'), play([x, 3, 2, 3, 1, 0]))).toBe(false) // no 9
    expect(realizes(chord('Bm7'), play([x, 2, 0, 2, 0, 2]))).toBe(true)
  })

  test.prop([
    fc.constantFrom('C', 'Am', 'G7', 'Fmaj7', 'Dsus4', 'E7#9', 'C/G'),
    fc.integer({ min: 0, max: 11 }),
  ])('fidelity is in [0, 1] and realizes implies no clash', (name, n) => {
    const target = transpose(chord(name), n)
    for (const e of getDefaultLibrary().byRoot[target.root] ?? []) {
      const f = fidelity(target, e.played)
      expect(f.value).toBeGreaterThanOrEqual(0)
      expect(f.value).toBeLessThanOrEqual(1)
      if (realizes(target, e.played)) expect(f.clash).toBe(false)
    }
  })
})

describe('fretboard generator', () => {
  it('finds playable shapes for a chord the library lacks', () => {
    const target = chord('C7#9#5')
    const shapes = generateVoicings(target)
    expect(shapes.length).toBeGreaterThan(0)
    for (const s of shapes) {
      expect(s.voicing.source).toBe('generated')
      expect(s.played.pcs.length).toBeGreaterThanOrEqual(4)
      expect(s.played.lowest).toBe(target.root)
      expect(realizes(target, s.played) || fidelity(target, s.played).missing.length > 0).toBe(true)
    }
    const d = shapes.map((s) => difficulty(s.info).total)
    expect(d).toEqual([...d].sort((a, b) => a - b))
  })

  it('respects the slash bass and the limit', () => {
    const shapes = generateVoicings(chord('D/F#'), { limit: 3, minStrings: 3 })
    expect(shapes.length).toBeLessThanOrEqual(3)
    for (const s of shapes) expect(s.played.lowest).toBe(6)
  })
})
