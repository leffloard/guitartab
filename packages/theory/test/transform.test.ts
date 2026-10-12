import { test } from '@fast-check/vitest'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { chordEquals, transpose } from '../src/chord.ts'
import { buildLibrary } from '../src/library.ts'
import { DEFAULT_DIFFICULTY, realizes } from '../src/score.ts'
import { formatChordSymbol, tryParseChordSymbol } from '../src/symbol.ts'
import {
  candidatesFor,
  capoPenalty,
  DEFAULT_LAMBDA,
  LAMBDA_STOPS,
  MODE_PRESETS,
  transform,
  type Mode,
  type TransformResult,
} from '../src/transform.ts'
import { spellPitchClass } from '../src/pitch.ts'
import { EB_STANDARD } from '../src/tuning.ts'
import { playedNotes } from '../src/voicing.ts'
import { commonSymbol, simpleSymbol } from './arbitraries.ts'

const MODES: Mode[] = ['original', 'capo', 'easy', 'beginner']
const makeChordStub = () => ({ root: 0 as const, intervals: 1, bass: null })
const labels = (...names: string[]) => names.map((label) => ({ label }))

function summary(r: TransformResult) {
  const o = r.option
  if (!o) return null
  return {
    capo: o.capo,
    shapes: o.symbols.map(
      (s) => `${formatChordSymbol(s.chord)}→${formatChordSymbol(s.played)} ${s.voicing.id}`,
    ),
    fullBarres: o.fullBarres,
    miniBarres: o.miniBarres,
  }
}

describe('acceptance: barre-free easy mode', () => {
  it('F–C–G–Am: no capo, F becomes Fmaj7, zero barres', () => {
    const r = transform(labels('F', 'C', 'G', 'Am'), { mode: 'easy' })
    expect(summary(r)).toEqual({
      capo: 0,
      shapes: ['F→Fmaj7 x-x-3-2-1-0', 'C→C x-3-2-0-1-0', 'G→G 3-2-0-0-0-3', 'Am→Am x-0-2-2-1-0'],
      fullBarres: 0,
      miniBarres: 0,
    })
    // Σ w·cost + μ·shapes, with the costs from the design document
    expect(r.option?.total).toBeCloseTo((3.2428571 + 1.7 + 1.3 + 2.1) / 4 + 4 * (0.1 / 4), 5)
    expect(r.alternatives.map((a) => a.capo)).toEqual([0, 5, 3])
    expect(r.alternatives[1]?.fullBarres).toBe(0)
  })

  it('Bm–G–D–A: no capo, Bm becomes Bm7, zero barres', () => {
    const r = transform(labels('Bm', 'G', 'D', 'A'), { mode: 'easy' })
    expect(summary(r)).toEqual({
      capo: 0,
      shapes: ['Bm→Bm7 x-2-0-2-0-2', 'G→G 3-2-0-0-0-3', 'D→D x-x-0-2-3-2', 'A→A x-0-2-2-2-0'],
      fullBarres: 0,
      miniBarres: 0,
    })
    expect(r.alternatives[1]?.capo).toBe(2)
  })

  it('B becomes B7 when nothing better exists', () => {
    const r = transform(labels('E', 'B'), { mode: 'easy', capoRange: [0, 0] })
    expect(r.option?.symbols[1]?.played).toEqual(tryParseChordSymbol('B7'))
    expect(r.option?.symbols[1]?.substituted).toBe(true)
  })
})

describe('acceptance: standard shapes are found', () => {
  const ids = (prog: string, mode: Mode) =>
    transform(labels(...prog.split(' ')), { mode }).option?.symbols.map((s) => s.voicing.id)

  it('plays D/F# with the open 2x0232 family, not a stretch', () => {
    expect(ids('G D/F# Em C', 'easy')?.[1]).toBe('2-0-0-2-3-2')
    expect(ids('G D/F# Em C', 'original')?.[1]).toBe('2-0-0-2-3-2')
  })

  it('offers shapes stored under another name (open C#m7 is "E/C#" in chords-db)', () => {
    expect(ids('C#m7', 'original')).toEqual(['x-4-2-1-0-0'])
  })

  it('keeps the standard C7 rather than an inversion', () => {
    expect(ids('G Em C7 D7', 'easy')).toEqual([
      '3-2-0-0-0-3',
      '0-2-2-0-0-0',
      'x-3-2-3-1-0',
      'x-x-0-2-1-2',
    ])
  })

  it('plays open power chords', () => {
    expect(ids('E5 A5 D5', 'original')).toEqual(['0-2-2-x-x-x', 'x-0-2-2-x-x', 'x-x-0-2-3-x'])
  })

  it('falls back to generated shapes for chords the library lacks', () => {
    const r = transform(labels('Dm7', 'Am7b9', 'G7', 'Cmaj7'), { mode: 'original' })
    expect(r.option?.symbols[1]?.voicing).toMatchObject({ source: 'generated', id: 'x-0-2-3-1-3' })
    const capo = transform(labels('C7#9#5'), { mode: 'capo' }).option
    expect(capo?.capo).toBe(1)
    expect(capo?.symbols[0]?.voicing).toMatchObject({ source: 'generated', id: '7-6-0-0-0-5' })
  })

  it('names an exact voicing after the chord, a substitute after its notes', () => {
    const o = transform(labels('C13#11b9'), { mode: 'original' }).option
    expect(o?.symbols[0]?.substituted).toBe(false)
    expect(formatChordSymbol(o?.symbols[0]?.played ?? makeChordStub())).toBe('C13b9#11')
  })
})

/**
 * Pins the mode presets: each case was found by mutating one preset value and checking that
 * this output changes (fidelity floors, minimum strings, μ).
 */
describe('mode preset golden cases', () => {
  const play = (prog: string, mode: Mode, lambda: number) => {
    const o = transform(labels(...prog.split(' ')), { mode, lambda }).option
    return (
      o && {
        capo: o.capo,
        shapes: o.symbols.map((s) => `${formatChordSymbol(s.played)} ${s.voicing.id}`),
      }
    )
  }

  it.each([
    ['Cm', 'easy', 2, 3, ['Am7 x-0-2-0-1-0']], // easy floor not lower than 0.75
    ['C', 'easy', 2, 0, ['Cmaj9 x-3-0-0-0-0']], // easy floor not higher than 0.75
    ['A5', 'easy', 40, 2, ['G5 3-x-0-0-3-3']], // easy needs 4 strings
    [
      'C C7 F G',
      'easy',
      10,
      0,
      ['C x-3-2-0-1-0', 'C7 x-3-2-3-1-0', 'Fmaj7 x-x-3-2-1-0', 'G 3-2-0-0-0-3'],
    ], // easy μ is small: no chord is merged into another's shape
    ['B7', 'beginner', 2, 2, ['A7add11 x-0-0-0-2-0']], // beginner floor not lower than 0.7
    ['Cm', 'beginner', 2, 3, ['Am7add11 x-0-0-0-1-0']], // beginner floor not higher than 0.7
    [
      'C C7 F G',
      'beginner',
      10,
      3,
      ['A7 x-0-2-0-2-0', 'A7 x-0-2-0-2-0', 'D x-x-0-2-3-2', 'E 0-2-2-1-0-0'],
    ], // beginner μ merges C and C7 into one shape
    ['A5', 'beginner', 20, 0, ['A5 x-0-2-2-x-x']], // beginner allows 3 strings
  ] as const)('%s (%s, λ=%d) → capo %d %j', (prog, mode, lambda, capo, shapes) => {
    expect(play(prog, mode, lambda)).toEqual({ capo, shapes: [...shapes] })
  })
})

describe('modes', () => {
  it('capo mode keeps every chord exact and finds capo 5 for F–C–G–Am', () => {
    const r = transform(labels('F', 'C', 'G', 'Am'), { mode: 'capo' })
    expect(summary(r)?.capo).toBe(5)
    expect(summary(r)?.shapes.map((s) => s.split(' ')[0])).toEqual(['F→C', 'C→G', 'G→D', 'Am→Em'])
    expect(r.option?.symbols.every((s) => !s.substituted)).toBe(true)
  })

  it('original mode never moves the capo and may keep barre shapes', () => {
    const r = transform(labels('F', 'Bm'), { mode: 'original' })
    expect(r.option?.capo).toBe(0)
    expect(r.alternatives).toHaveLength(1)
    expect(r.option?.symbols.every((s) => !s.substituted)).toBe(true)
    expect((r.option?.fullBarres ?? 0) + (r.option?.miniBarres ?? 0)).toBeGreaterThan(0)
  })

  it('beginner mode drops 9ths/11ths/13ths before choosing shapes', () => {
    const r = transform(labels('Cadd9', 'G', 'Am7', 'Fmaj9'), {
      mode: 'beginner',
      capoRange: [0, 0],
    })
    const chords = r.option?.symbols.map((s) => formatChordSymbol(s.chord))
    expect(chords).toEqual(['C', 'G', 'Am7', 'Fmaj7'])
    expect(r.items.map((i) => i.choice !== null)).toEqual([true, true, true, true])
  })

  it('the λ slider trades fidelity for ease', () => {
    const at = (lambda: number) =>
      transform(labels('F', 'C', 'G', 'Am'), { mode: 'easy', lambda, capoRange: [0, 0] })
    expect(at(10).option?.symbols[0]?.voicing.id).toBe('x-x-3-2-1-0')
    expect(at(40).option?.symbols[0]?.voicing.id).toBe('x-x-3-2-1-1')
    expect(LAMBDA_STOPS).toContain(DEFAULT_LAMBDA)
  })

  it('honors "no capo" and an explicitly requested capo', () => {
    expect(
      transform(labels('F', 'C', 'G', 'Am'), { mode: 'capo', capoRange: [0, 0] }).option?.capo,
    ).toBe(0)
    const forced = transform(labels('F', 'C', 'G', 'Am'), { mode: 'easy', capo: 3 })
    expect(forced.option?.capo).toBe(3)
    expect(forced.alternatives[0]?.capo).toBe(3)
  })

  it('transposes the song before arranging it', () => {
    const up = transform(labels('E', 'B', 'C#m', 'A'), { mode: 'capo', transpose: -4 })
    const direct = transform(labels('C', 'G', 'Am', 'F'), { mode: 'capo' })
    expect(up.items.map((i) => i.input && formatChordSymbol(i.input))).toEqual([
      'C',
      'G',
      'Am',
      'F',
    ])
    expect(up.option?.symbols.map((s) => s.voicing.id)).toEqual(
      direct.option?.symbols.map((s) => s.voicing.id),
    )
  })

  it('penalizes high capos more and more', () => {
    expect(capoPenalty(0)).toBe(0)
    expect(capoPenalty(5)).toBeCloseTo(0.7, 12)
    expect(capoPenalty(7) - capoPenalty(6)).toBeGreaterThan(capoPenalty(2) - capoPenalty(1))
  })

  it('supports a half-step-down tuning with the same shapes', () => {
    const standard = transform(labels('F', 'C', 'G', 'Am'), { mode: 'easy' })
    const eb = transform(labels('E', 'B', 'F#', 'G#m'), { mode: 'easy', tuning: EB_STANDARD })
    expect(eb.option?.capo).toBe(standard.option?.capo)
    expect(eb.option?.symbols.map((s) => s.voicing.id)).toEqual(
      standard.option?.symbols.map((s) => s.voicing.id),
    )
    expect(() =>
      transform(labels('C'), {
        mode: 'easy',
        tuning: { id: 'drop-d', midi: [38, 45, 50, 55, 59, 64] },
      }),
    ).toThrow(/uniform/)
  })
})

describe('items, no-chord segments and errors', () => {
  it('keeps every input item, including N and unparsable labels', () => {
    const r = transform(
      [
        { label: 'N', start: 0, end: 1 },
        { label: 'C:maj', start: 1, end: 3 },
        { label: 'G', start: 3, end: 5 },
        { label: '??', start: 5, end: 6 },
      ],
      { mode: 'easy' },
    )
    expect(r.items).toHaveLength(4)
    expect(r.items[0]).toMatchObject({ input: null, choice: null, start: 0, end: 1 })
    expect(r.items[1]?.choice?.voicing).toBeDefined()
    expect(r.items[3]?.invalid).toMatch(/cannot parse/)
  })

  it('reports capos where some chord cannot be played', () => {
    const r = transform(labels('C7b9#9#11b13'), { mode: 'original' })
    expect(r.option).toBeNull()
    expect(r.alternatives).toEqual([])
    expect(r.infeasibleCapos).toEqual([0])
    expect(r.items[0]?.choice).toBeNull()
  })

  it('works with a custom library', () => {
    const tiny = buildLibrary([
      { tuning: 'standard', voicings: [{ chord: 'C', frets: [null, 3, 2, 0, 1, 0] }] },
    ])
    const r = transform(labels('D'), { mode: 'capo', library: tiny })
    expect(r.option?.capo).toBe(2)
    expect(r.option?.symbols[0]?.voicing.id).toBe('x-3-2-0-1-0')
  })

  it('returns no option when the progression has no chords', () => {
    const r = transform(labels('N'), { mode: 'easy' })
    expect(r.option?.symbols).toEqual([])
  })

  it('spells input and shape names by key', () => {
    const r = transform(labels('Bb', 'Eb', 'F'), { mode: 'capo', capoRange: [1, 1] })
    expect(r.option?.capo).toBe(1)
    // Shapes A–D–E are in A major: G#, not Ab. Inputs are in Bb major: Ab, not G#.
    expect(spellPitchClass(8, r.spelling.shape)).toBe('G#')
    expect(spellPitchClass(8, r.spelling.input)).toBe('Ab')
    const spell = (prog: string) => {
      const t = transform(labels(...prog.split(' ')), { mode: 'original' })
      return t.items.map((i) =>
        i.input ? formatChordSymbol(i.input, { spelling: t.spelling.input }) : '-',
      )
    }
    expect(spell('C E/G# Am')).toEqual(['C', 'E/G#', 'Am'])
    expect(spell('Am Dm G#dim Am')).toEqual(['Am', 'Dm', 'G#dim', 'Am'])
    expect(spell('F Bb C Db F')).toEqual(['F', 'Bb', 'C', 'Db', 'F'])
    expect(spell('Gb Db Ebm')).toEqual(['Gb', 'Db', 'Ebm'])
    expect(spell('F# C# D#m')).toEqual(['F#', 'C#', 'D#m'])
  })
})

describe('properties', () => {
  const progression = fc.array(commonSymbol, { minLength: 1, maxLength: 5 })

  test.prop([fc.array(simpleSymbol, { minLength: 1, maxLength: 5 })], { numRuns: 40 })(
    'capo mode never changes a chord: the shape played with the capo is the chord as written',
    (names) => {
      const r = transform(labels(...names), { mode: 'capo' })
      const o = r.option
      expect(o).not.toBeNull()
      for (const s of o?.symbols ?? []) {
        expect(chordEquals(transpose(s.shape, o?.capo ?? 0), s.chord)).toBe(true)
        expect(s.substituted).toBe(false)
      }
    },
  )

  // With full barres made free, only the forbidFullBarre rule keeps them out of easy mode.
  const cheapBarre = { ...DEFAULT_DIFFICULTY, fullBarre: 0 }
  test.prop(
    [fc.array(simpleSymbol, { minLength: 1, maxLength: 4 }), fc.constantFrom(...LAMBDA_STOPS)],
    { numRuns: 40 },
  )('easy mode uses no full barre wherever the library offers an alternative', (names, lambda) => {
    const opts = { mode: 'easy', lambda, difficultyWeights: cheapBarre } as const
    const o = transform(labels(...names), opts).option
    if (!o) return
    for (const s of o.symbols) {
      const options = candidatesFor(
        s.shape,
        o.capo,
        { ...MODE_PRESETS.easy, forbidFullBarre: false },
        opts,
      )
      const hasAlternative = options.some((c) => !c.entry.info.barres.some((b) => b.full))
      const chosen = options.find((c) => c.entry.voicing.id === s.voicing.id)
      expect(chosen).toBeDefined()
      if (hasAlternative) expect(chosen?.entry.info.barres.some((b) => b.full)).toBe(false)
    }
  })

  test.prop([progression, fc.constantFrom(...MODES)], { numRuns: 30 })(
    'never throws for parsable chords, and is deterministic',
    (names, mode) => {
      const a = transform(labels(...names), { mode })
      const b = transform(labels(...names), { mode })
      expect(summary(a)).toEqual(summary(b))
    },
  )

  test.prop(
    [
      fc.array(fc.tuple(simpleSymbol, fc.double({ min: 0.5, max: 8, noNaN: true })), {
        minLength: 1,
        maxLength: 5,
      }),
      fc.double({ min: 0.5, max: 4, noNaN: true }),
    ],
    { numRuns: 25 },
  )('adding no-chord segments or rescaling time changes nothing', (segments, k) => {
    let t = 0
    const timed = segments.map(([label, d]) => ({ label, start: t, end: (t += d) }))
    const scaled = timed.map((s) => ({ ...s, start: s.start * k, end: s.end * k }))
    const withN = [
      { label: 'N', start: -2, end: 0 },
      ...timed,
      { label: 'N', start: t, end: t + 3 },
    ]
    const base = summary(transform(timed, { mode: 'easy', minSegmentSec: 0 }))
    expect(summary(transform(scaled, { mode: 'easy', minSegmentSec: 0 }))).toEqual(base)
    expect(summary(transform(withN, { mode: 'easy', minSegmentSec: 0 }))).toEqual(base)
  })

  test.prop(
    [fc.array(simpleSymbol, { minLength: 1, maxLength: 4 }), fc.integer({ min: 0, max: 5 })],
    {
      numRuns: 25,
    },
  )('at a fixed capo, a higher λ never lowers the weighted fidelity', (names, capo) => {
    const fidelityAt = (lambda: number) => {
      const o = transform(labels(...names), {
        mode: 'easy',
        lambda,
        capoRange: [capo, capo],
      }).option
      return o ? o.meanFidelity : null
    }
    const values = LAMBDA_STOPS.map(fidelityAt)
    if (values.some((v) => v === null)) return
    for (let i = 1; i < values.length; i++) {
      expect(values[i] ?? 0).toBeGreaterThanOrEqual((values[i - 1] ?? 0) - 1e-9)
    }
  })

  test.prop([fc.array(simpleSymbol, { minLength: 1, maxLength: 4 })], { numRuns: 20 })(
    'every voicing chosen in capo/original mode realizes its shape',
    (names) => {
      for (const mode of ['capo', 'original'] as const) {
        const o = transform(labels(...names), { mode }).option
        for (const s of o?.symbols ?? []) {
          expect(realizes(s.shape, playedNotes(s.voicing.frets))).toBe(true)
          expect(s.substituted).toBe(false)
        }
      }
    },
  )
})
