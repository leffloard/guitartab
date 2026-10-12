import { test } from '@fast-check/vitest'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { chordEquals, transpose } from '../src/chord.ts'
import { buildLibrary } from '../src/library.ts'
import { realizes } from '../src/score.ts'
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
import { EB_STANDARD } from '../src/tuning.ts'
import { playedNotes } from '../src/voicing.ts'
import { commonSymbol, simpleSymbol } from './arbitraries.ts'

const MODES: Mode[] = ['original', 'capo', 'easy', 'beginner']
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
    expect(r.option?.total).toBeCloseTo((3.2428571 + 1.7 + 1.3 + 2.1) / 4 + 0.4, 5)
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
    const tiny = buildLibrary([
      { tuning: 'standard', voicings: [{ chord: 'C', frets: [null, 3, 2, 0, 1, 0] }] },
    ])
    // Only a C shape exists, so only the capo that turns D into a C shape (2) works without the
    // generator, and the generator is restricted by the physical fret limit at high capos.
    const r = transform(labels('D'), { mode: 'capo', library: tiny })
    expect(r.option).not.toBeNull()
    expect(r.option?.capo).toBe(2)
  })

  it('returns no option when the progression has no chords', () => {
    const r = transform(labels('N'), { mode: 'easy' })
    expect(r.option?.symbols).toEqual([])
  })

  it('spells shape names in the key of the shapes', () => {
    const r = transform(labels('Bb', 'Eb', 'F'), { mode: 'capo', capoRange: [1, 1] })
    expect(typeof r.spelling.shape).toBe('object')
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

  test.prop([fc.array(simpleSymbol, { minLength: 1, maxLength: 4 })], { numRuns: 40 })(
    'easy mode uses no full barre wherever the library offers an alternative',
    (names) => {
      const r = transform(labels(...names), { mode: 'easy' })
      const o = r.option
      if (!o) return
      for (const s of o.symbols) {
        const options = candidatesFor(
          s.shape,
          o.capo,
          { ...MODE_PRESETS.easy, forbidFullBarre: false },
          { mode: 'easy', lambda: DEFAULT_LAMBDA },
        )
        const hasAlternative = options.some((c) => !c.entry.info.barres.some((b) => b.full))
        const chosen = options.find((c) => c.entry.voicing.id === s.voicing.id)
        if (hasAlternative) expect(chosen?.entry.info.barres.some((b) => b.full)).toBe(false)
      }
    },
  )

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
