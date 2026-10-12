import { test } from '@fast-check/vitest'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  bruteForceAssignment,
  evaluateAssignment,
  solveAssignment,
  type AssignmentProblem,
} from '../src/assign.ts'
import { makeChord, transpose } from '../src/chord.ts'
import { estimateKeySignature, spellingForKey } from '../src/key.ts'
import { spellPitchClass } from '../src/pitch.ts'
import { parseChordLabel, symbolWeights } from '../src/progression.ts'
import { tryParseChordSymbol } from '../src/symbol.ts'

const problem = fc.integer({ min: 1, max: 5 }).chain((n) =>
  fc.record({
    weights: fc.array(fc.double({ min: 0.05, max: 1, noNaN: true }), {
      minLength: n,
      maxLength: n,
    }),
    candidates: fc.array(
      fc.array(
        fc.record({
          id: fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f'),
          cost: fc.double({ min: -1, max: 10, noNaN: true }),
        }),
        { minLength: 1, maxLength: 4 },
      ),
      { minLength: n, maxLength: n },
    ),
    mu: fc.constantFrom(0, 0.1, 0.5, 2),
  }),
)

describe('voicing assignment (facility location)', () => {
  test.prop([problem])('branch and bound finds the brute-force optimum', (p: AssignmentProblem) => {
    const exact = bruteForceAssignment(p)
    const bb = solveAssignment(p)
    expect(bb.exact).toBe(true)
    expect(bb.total).toBeCloseTo(exact.total, 9)
    expect(evaluateAssignment(p, bb.choice)).toBeCloseTo(bb.total, 12)
  })

  it('shares a shape when that saves more than it costs', () => {
    const p: AssignmentProblem = {
      weights: [0.5, 0.5],
      candidates: [
        [
          { id: 'x', cost: 1 },
          { id: 'shared', cost: 1.1 },
        ],
        [
          { id: 'y', cost: 1 },
          { id: 'shared', cost: 1.1 },
        ],
      ],
      mu: 0.5,
    }
    expect(solveAssignment(p).choice).toEqual([1, 1])
    expect(solveAssignment({ ...p, mu: 0 }).choice).toEqual([0, 0])
  })

  it('handles empty and infeasible problems', () => {
    expect(solveAssignment({ weights: [], candidates: [], mu: 1 })).toEqual({
      choice: [],
      total: 0,
      exact: true,
    })
    expect(solveAssignment({ weights: [1], candidates: [[]], mu: 1 }).total).toBe(Infinity)
    expect(bruteForceAssignment({ weights: [1], candidates: [[]], mu: 1 }).total).toBe(Infinity)
    expect(() => evaluateAssignment({ weights: [1], candidates: [[]], mu: 1 }, [0])).toThrow()
  })

  it('returns its best effort when the node limit is hit', () => {
    const n = 8
    const p: AssignmentProblem = {
      weights: new Array<number>(n).fill(1 / n),
      candidates: Array.from({ length: n }, (_, i) =>
        ['a', 'b', 'c', 'd'].map((id, k) => ({ id: `${id}${(i + k) % 3}`, cost: 1 + k * 0.01 })),
      ),
      mu: 1,
    }
    const limited = solveAssignment(p, 3)
    expect(limited.exact).toBe(false)
    expect(Number.isFinite(limited.total)).toBe(true)
    expect(solveAssignment(p).total).toBeLessThanOrEqual(limited.total)
  })
})

describe('progressions', () => {
  it('parses chord symbols, Harte labels and no-chord markers', () => {
    expect(parseChordLabel('Am7')).toMatchObject({ kind: 'chord', chord: { root: 9 } })
    expect(parseChordLabel('A:min7')).toEqual(parseChordLabel('Am7'))
    expect(parseChordLabel('C/3')).toEqual(parseChordLabel('C/E'))
    for (const nc of ['N', 'X', 'N.C.', 'NC', 'n.c.'])
      expect(parseChordLabel(nc).kind).toBe('no-chord')
    expect(parseChordLabel('Hm7').kind).toBe('invalid')
    expect(parseChordLabel('C:foo').kind).toBe('invalid')
  })

  const C = makeChord(0, [4, 7])
  const G = makeChord(7, [4, 7])

  it('weights untimed chords by occurrences, counting repeats once', () => {
    const w = symbolWeights([{ chord: C }, { chord: C }, { chord: G }, { chord: C }])
    expect(w.map((x) => x.weight)).toEqual([2 / 3, 1 / 3])
  })

  it('weights timed chords half by duration and half by occurrences', () => {
    const w = symbolWeights([
      { chord: C, start: 0, end: 3 },
      { chord: G, start: 3, end: 4 },
    ])
    expect(w[0]?.weight).toBeCloseTo(0.5 * 0.75 + 0.5 * 0.5, 12)
    expect(w[1]?.weight).toBeCloseTo(0.5 * 0.25 + 0.5 * 0.5, 12)
  })

  it('does not count very short segments as occurrences', () => {
    const w = symbolWeights(
      [
        { chord: C, start: 0, end: 4 },
        { chord: G, start: 4, end: 4.1 },
      ],
      { minSegmentSec: 0.25 },
    )
    expect(w[1]?.weight).toBeCloseTo(0.5 * (0.1 / 4.1), 12)
    const onlyShort = symbolWeights([{ chord: C, start: 0, end: 0.1 }])
    expect(onlyShort[0]?.weight).toBe(1)
    const zeroLength = symbolWeights([
      { chord: C, start: 1, end: 1 },
      { chord: G, start: 1, end: 1 },
    ])
    expect(zeroLength.map((x) => x.weight)).toEqual([0.5, 0.5])
  })
})

describe('key signature and spelling', () => {
  const chords = (names: string[]) =>
    names.map((n) => ({ chord: tryParseChordSymbol(n) ?? makeChord(0, 1), weight: 1 }))

  it('finds the key signature of common progressions', () => {
    expect(estimateKeySignature(chords(['C', 'G', 'Am', 'F']))).toEqual({
      tonic: 0,
      accidentals: 0,
    })
    expect(estimateKeySignature(chords(['E', 'B', 'C#m', 'A']))).toEqual({
      tonic: 4,
      accidentals: 4,
    })
    expect(estimateKeySignature(chords(['Bb', 'F', 'Gm', 'Eb']))).toEqual({
      tonic: 10,
      accidentals: -2,
    })
    expect(estimateKeySignature([])).toEqual({ tonic: 0, accidentals: 0 })
  })

  it('spells diatonic notes by the signature and others neutrally', () => {
    const eMajor = spellingForKey({ tonic: 4, accidentals: 4 })
    expect(spellPitchClass(3, eMajor)).toBe('D#')
    expect(spellPitchClass(10, eMajor)).toBe('Bb')
    const abMajor = spellingForKey({ tonic: 8, accidentals: -4 })
    expect(spellPitchClass(1, abMajor)).toBe('Db')
    expect(spellPitchClass(6, abMajor)).toBe('F#')
    expect(spellPitchClass(1, spellingForKey({ tonic: 0, accidentals: 0 }))).toBe('C#')
  })

  test.prop([fc.integer({ min: 0, max: 11 })])('a transposed I–V–vi–IV keeps its tonic', (n) => {
    const base = chords(['C', 'G', 'Am', 'F'])
    const moved = base.map(({ chord, weight }) => ({ chord: transpose(chord, n), weight }))
    expect(estimateKeySignature(moved).tonic).toBe(n)
  })
})
