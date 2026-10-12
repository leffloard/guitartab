import { test } from '@fast-check/vitest'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  chordEquals,
  chordKey,
  chordTones,
  describe as describeChord,
  identifyChord,
  intervalsOf,
  makeChord,
  pitchClassesOf,
  simplify,
  structureToIntervals,
  transpose,
  type Chord,
} from '../src/chord.ts'
import { formatHarte, parseHarte } from '../src/harte.ts'
import { degreeToSemitones, intervalName } from '../src/intervals.ts'
import { mod12, parseNote, parseNoteAt, spellPitchClass, type Spelling } from '../src/pitch.ts'
import { formatChordSymbol, parseChordSymbol, tryParseChordSymbol } from '../src/symbol.ts'
import { anyChord } from './arbitraries.ts'

const ALL_MASKS = Array.from({ length: 2048 }, (_, i) => (i << 1) | 1)
const SPELLINGS: Spelling[] = ['neutral', 'sharp', 'flat']

function symbol(text: string): Chord {
  const r = parseChordSymbol(text)
  if (!r.ok) throw new Error(`${text}: ${r.error.message}`)
  return r.chord
}

function harte(text: string): Chord {
  const r = parseHarte(text)
  if (r?.kind !== 'chord') throw new Error(`not a Harte chord: ${text}`)
  return r.chord
}

describe('pitch', () => {
  it('parses note names with any accidentals', () => {
    expect(parseNote('C')).toBe(0)
    expect(parseNote('F#')).toBe(6)
    expect(parseNote('Bb')).toBe(10)
    expect(parseNote('B♭')).toBe(10)
    expect(parseNote('F♯')).toBe(6)
    expect(parseNote('Cb')).toBe(11)
    expect(parseNote('E#')).toBe(5)
    expect(parseNote('Ebb')).toBe(2)
    expect(parseNote('H')).toBeNull()
    expect(parseNote('')).toBeNull()
    expect(parseNote('C#m')).toBeNull()
    expect(parseNoteAt('Am7')).toEqual({ pc: 9, length: 1 })
    expect(parseNoteAt('x', 0)).toBeNull()
    expect(parseNoteAt('', 0)).toBeNull()
  })

  it('spells pitch classes', () => {
    expect(spellPitchClass(1)).toBe('C#')
    expect(spellPitchClass(3)).toBe('Eb')
    expect(spellPitchClass(3, 'sharp')).toBe('D#')
    expect(spellPitchClass(6, 'flat')).toBe('Gb')
    expect(spellPitchClass(1, { names: ['C', 'Db'] })).toBe('Db')
    expect(spellPitchClass(5, { names: [] })).toBe('F')
  })

  test.prop([fc.integer({ min: -1000, max: 1000 })])('mod12 is periodic and in range', (n) => {
    const pc = mod12(n)
    expect(pc).toBeGreaterThanOrEqual(0)
    expect(pc).toBeLessThan(12)
    expect(mod12(n + 12)).toBe(pc)
  })

  test.prop([fc.integer({ min: 0, max: 11 }), fc.constantFrom(...SPELLINGS)])(
    'spelling then parsing gives the same pitch class',
    (pc, spelling) => {
      expect(parseNote(spellPitchClass(mod12(pc), spelling))).toBe(pc)
    },
  )
})

describe('intervals', () => {
  it('converts degrees to semitones', () => {
    expect(degreeToSemitones('1')).toBe(0)
    expect(degreeToSemitones('b3')).toBe(3)
    expect(degreeToSemitones('#11')).toBe(18)
    expect(degreeToSemitones('bb7')).toBe(9)
    expect(degreeToSemitones('13')).toBe(21)
    expect(degreeToSemitones('14')).toBeNull()
    expect(degreeToSemitones('x')).toBeNull()
  })

  it('names intervals', () => {
    expect(intervalName(3, 'compound')).toBe('#9')
    expect(intervalName(3, 'simple')).toBe('b3')
    expect(intervalName(-2, 'simple')).toBe('b7')
  })
})

describe('chord model', () => {
  it('normalizes the root bit and a bass equal to the root', () => {
    const c = makeChord(12, [4, 7], 0)
    expect(c).toEqual({ root: 0, intervals: 0b10010001, bass: null })
    expect(intervalsOf(c)).toEqual([0, 4, 7])
    expect(pitchClassesOf(makeChord(9, [3, 7]))).toEqual([9, 0, 4])
  })

  it('classifies every one of the 2048 interval sets into a lossless structure', () => {
    for (const mask of ALL_MASKS) {
      const c = makeChord(0, mask)
      expect(structureToIntervals(describeChord(c))).toBe(mask)
    }
  })

  it('names common structures', () => {
    expect(describeChord(symbol('Cm7b5'))).toMatchObject({
      third: 'm3',
      fifth: 'b5',
      seventh: 'b7',
    })
    expect(describeChord(symbol('Cdim7'))).toMatchObject({ seventh: 'bb7', sixth: false })
    expect(describeChord(symbol('C6'))).toMatchObject({ seventh: null, sixth: true })
    expect(describeChord(symbol('C13')).tensions).toEqual(['9', '13'])
    expect(describeChord(symbol('C7#9')).tensions).toEqual(['#9'])
    expect(describeChord(makeChord(0, [10, 11])).extras).toEqual([11])
  })

  test.prop([anyChord, fc.integer({ min: -30, max: 30 }), fc.integer({ min: -30, max: 30 })])(
    'transposition is a group action',
    (c, a, b) => {
      expect(transpose(transpose(c, a), -a)).toEqual(c)
      expect(transpose(transpose(c, a), b)).toEqual(transpose(c, a + b))
      expect(transpose(c, 12)).toEqual(c)
      expect(chordEquals(transpose(c, 0), c)).toBe(true)
    },
  )

  test.prop([anyChord, fc.integer({ min: -11, max: 11 })])(
    'chord tones keep their intervals and roles under transposition',
    (c, n) => {
      expect(chordTones(transpose(c, n))).toEqual(chordTones(c))
    },
  )

  it('lists chord tones with roles', () => {
    const tones = chordTones(symbol('C9/D'))
    expect(tones.map((t) => [t.interval, t.role])).toEqual([
      [0, 'root'],
      [4, 'third'],
      [7, 'fifth'],
      [10, 'seventh'],
      [2, 'tension'],
    ])
    expect(tones.find((t) => t.role === 'tension')?.highest).toBe(true)
    expect(chordTones(symbol('C/D')).at(-1)).toMatchObject({ interval: 2, role: 'bass' })
    expect(chordTones(symbol('C5')).find((t) => t.role === 'fifth')?.essential).toBe(true)
    expect(chordTones(symbol('C')).find((t) => t.role === 'fifth')?.essential).toBe(false)
    expect(chordTones(symbol('C6')).map((t) => t.role)).toContain('sixth')
  })

  it('simplifies by dropping tensions', () => {
    const cases: [string, string][] = [
      ['C9', 'C7'],
      ['Cadd9', 'C'],
      ['C6/9', 'C6'],
      ['Cm11', 'Cm7'],
      ['C13', 'C7'],
      ['C7b9/E', 'C7/E'],
      ['G', 'G'],
    ]
    for (const [from, to] of cases) {
      expect(simplify(symbol(from), 'drop-tensions'), from).toEqual(symbol(to))
      expect(simplify(symbol(from), 'none')).toEqual(symbol(from))
    }
  })

  it('identifies played notes relative to a known root', () => {
    // xx3210 over F plays F A C E → Fmaj7
    expect(formatChordSymbol(identifyChord([5, 9, 0, 4], 5, 5))).toBe('Fmaj7')
    // x32310 over C: no G, but the fifth is implied → C7
    expect(formatChordSymbol(identifyChord([0, 4, 10, 0, 4], 0, 0))).toBe('C7')
    // 032010 over C with E in the bass → C/E
    expect(formatChordSymbol(identifyChord([4, 0, 4, 7, 0, 4], 0, 4))).toBe('C/E')
    expect(formatChordSymbol(identifyChord([0, 7], 0))).toBe('C5')
  })

  it('has a stable key', () => {
    expect(chordKey(symbol('Am/G'))).toBe(chordKey(harte('A:min/b7')))
    expect(chordKey(symbol('Am'))).not.toBe(chordKey(symbol('Am/G')))
  })
})

/** Chord symbols with the Harte label that denotes the same pitch content. */
const CORPUS: readonly (readonly [string, string])[] = [
  ['C', 'C:maj'],
  ['Cmaj', 'C:maj'],
  ['CM', 'C:maj'],
  [' Am ', 'A:min'],
  ['Cm', 'C:min'],
  ['Cmin', 'C:min'],
  ['Cmi', 'C:min'],
  ['C-', 'C:min'],
  ['C7', 'C:7'],
  ['Cmaj7', 'C:maj7'],
  ['CM7', 'C:maj7'],
  ['CΔ', 'C:maj7'],
  ['CΔ7', 'C:maj7'],
  ['C△7', 'C:maj7'],
  ['Cma7', 'C:maj7'],
  ['CMaj7', 'C:maj7'],
  ['Cm7', 'C:min7'],
  ['C-7', 'C:min7'],
  ['Cmin7', 'C:min7'],
  ['CmM7', 'C:minmaj7'],
  ['Cm(maj7)', 'C:minmaj7'],
  ['Cmmaj7', 'C:minmaj7'],
  ['Cdim', 'C:dim'],
  ['C°', 'C:dim'],
  ['Co', 'C:dim'],
  ['Cdim7', 'C:dim7'],
  ['C°7', 'C:dim7'],
  ['Co7', 'C:dim7'],
  ['Cm7b5', 'C:hdim7'],
  ['Cø', 'C:hdim7'],
  ['Cø7', 'C:hdim7'],
  ['Cm7(b5)', 'C:hdim7'],
  ['C-7b5', 'C:hdim7'],
  ['Cmin7-5', 'C:hdim7'],
  ['Caug', 'C:aug'],
  ['C+', 'C:aug'],
  ['C7#5', 'C:aug(b7)'],
  ['C+7', 'C:aug(b7)'],
  ['Caug7', 'C:aug(b7)'],
  ['C7+5', 'C:aug(b7)'],
  ['Csus4', 'C:sus4'],
  ['Csus', 'C:sus4'],
  ['Csus2', 'C:sus2'],
  ['C2', 'C:sus2'],
  ['C4', 'C:sus4'],
  ['C7sus4', 'C:sus4(b7)'],
  ['C7sus', 'C:sus4(b7)'],
  ['C9sus4', 'C:sus4(b7,9)'],
  ['Csus2sus4', 'C:(1,2,4,5)'],
  ['C5', 'C:5'],
  ['C(no3)', 'C:5'],
  ['C6', 'C:maj6'],
  ['Cm6', 'C:min6'],
  ['C6/9', 'C:maj6(9)'],
  ['C69', 'C:maj6(9)'],
  ['Cm6/9', 'C:min6(9)'],
  ['C6add9', 'C:maj6(9)'],
  ['C9', 'C:9'],
  ['Cmaj9', 'C:maj9'],
  ['CM9', 'C:maj9'],
  ['Cm9', 'C:min9'],
  ['C11', 'C:11'],
  ['Cm11', 'C:min11'],
  ['C13', 'C:7(9,13)'],
  ['Cmaj13', 'C:maj7(9,13)'],
  ['Cm13', 'C:min7(9,13)'],
  ['Cadd9', 'C:maj(9)'],
  ['Cadd2', 'C:maj(9)'],
  ['Cmadd9', 'C:min(9)'],
  ['Cm(add9)', 'C:min(9)'],
  ['Cadd11', 'C:maj(11)'],
  ['Cadd4', 'C:maj(11)'],
  ['C7b9', 'C:7(b9)'],
  ['C7#9', 'C:7(#9)'],
  ['C7(#9)', 'C:7(#9)'],
  ['C7b5', 'C:(1,3,b5,b7)'],
  ['C7(b5)', 'C:(1,3,b5,b7)'],
  ['C7-5', 'C:(1,3,b5,b7)'],
  ['C7#11', 'C:7(#11)'],
  ['C9#11', 'C:9(#11)'],
  ['C7b13', 'C:7(b13)'],
  ['C13b9', 'C:7(b9,13)'],
  ['C7b9#9', 'C:7(b9,#9)'],
  ['C7(b9,#9)', 'C:7(b9,#9)'],
  ['Cmaj7#11', 'C:maj7(#11)'],
  ['Cmaj9#11', 'C:maj9(#11)'],
  ['Cmaj7#5', 'C:aug(7)'],
  ['Cmaj7b5', 'C:(1,3,b5,7)'],
  ['C(b5)', 'C:(1,3,b5)'],
  ['Cm(#5)', 'C:(1,b3,#5)'],
  ['C7(9)', 'C:9'],
  ['C7(13)', 'C:7(13)'],
  ['C7add13', 'C:7(13)'],
  ['Cm7add11', 'C:min7(11)'],
  ['Cno5', 'C:(1,3)'],
  ['C7no3', 'C:(1,5,b7)'],
  ['C/E', 'C:maj/3'],
  ['C/G', 'C:maj/5'],
  ['C/D', 'C:maj/2'],
  ['Am/G', 'A:min/b7'],
  ['Bb/D', 'Bb:maj/3'],
  ['D/F#', 'D:maj/3'],
  ['G/B', 'G:maj/3'],
  ['C6/9/E', 'C:maj6(9)/3'],
  ['F#m7b5', 'F#:hdim7'],
  ['Ebmaj7', 'Eb:maj7'],
  ['Abm', 'Ab:min'],
  ['C#m7', 'C#:min7'],
  ['Gb7', 'Gb:7'],
  ['B♭maj7', 'Bb:maj7'],
  ['F♯m', 'F#:min'],
  ['E7#9', 'E:7(#9)'],
  ['A7sus4', 'A:sus4(b7)'],
  ['Dsus2', 'D:sus2'],
  ['G6', 'G:maj6'],
  // Brazilian / European chord-book notations
  ['Bm7(5-)', 'B:hdim7'],
  ['E7(9-)', 'E:7(b9)'],
  ['C7(9+)', 'C:7(#9)'],
  ['G7(5+)', 'G:aug(b7)'],
  ['G5+', 'G:aug'],
  ['C7(13-)', 'C:7(b13)'],
  ['C(11+)', 'C:maj(#11)'],
  ['C7M', 'C:maj7'],
  ['C7maj', 'C:maj7'],
  ['Am7M', 'A:minmaj7'],
  ['Am(7M)', 'A:minmaj7'],
  ['C7M(9)', 'C:maj9'],
  ['CMA7', 'C:maj7'],
  ['CMI7', 'C:min7'],
  ['C6(9)', 'C:maj6(9)'],
  ['Cm6(9)', 'C:min6(9)'],
  ['G7°', 'G:dim7'],
  ['G7dim', 'G:dim7'],
  ['C7/9', 'C:9'],
  ['Cm(b6)', 'C:min(b13)'],
  ['C9-5', 'C:9(b5,*5)'],
  ['C13b9', 'C:7(b9,13)'],
]

describe('chord symbols', () => {
  it.each(CORPUS)('%s = %s', (sym, harteLabel) => {
    expect(symbol(sym)).toEqual(harte(harteLabel))
  })

  it.each([
    '',
    'H',
    'Cxyz',
    'C7alt',
    'C7b11',
    'Am/X',
    'm7',
    '7',
    'Caddx',
    'A7+',
    'C13+',
    'C11-',
    'C6#6',
  ])('rejects %j', (bad) => {
    expect(parseChordSymbol(bad).ok).toBe(false)
    expect(tryParseChordSymbol(bad)).toBeNull()
  })

  it('reports where parsing failed', () => {
    const r = parseChordSymbol('C7alt')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.at).toBe(2)
  })

  it('formats common chords the way chord sheets write them', () => {
    const cases: [string, string][] = [
      ['C', 'C'],
      ['Am', 'Am'],
      ['G7', 'G7'],
      ['Fmaj7', 'Fmaj7'],
      ['Bm7', 'Bm7'],
      ['F#m7b5', 'F#m7b5'],
      ['Bdim', 'Bdim'],
      ['Bdim7', 'Bdim7'],
      ['Caug', 'Caug'],
      ['C7#5', 'C7#5'],
      ['Gsus4', 'Gsus4'],
      ['D7sus4', 'D7sus4'],
      ['Cadd9', 'Cadd9'],
      ['C6/9', 'C6/9'],
      ['Am6', 'Am6'],
      ['E7#9', 'E7#9'],
      ['C9', 'C9'],
      ['C11', 'C11'],
      ['C13', 'C13'],
      ['Cmaj9', 'Cmaj9'],
      ['CmM7', 'Cmmaj7'],
      ['A5', 'A5'],
      ['C(b5)', 'C(b5)'],
      ['C7(13)', 'C7add13'],
      ['Bb/D', 'Bb/D'],
      ['C/D', 'C/D'],
      ['Csus2sus4', 'Csus4add9'],
      ['Cno5', 'Cno5'],
      ['C7no3', 'C7no3'],
      ['C13b9#11', 'C13b9#11'],
      ['C11b9', 'C11b9'],
      ['C7M', 'Cmaj7'],
    ]
    for (const [input, expected] of cases)
      expect(formatChordSymbol(symbol(input)), input).toBe(expected)
  })

  it('writes fixed-do solfège names', () => {
    const solfege = (text: string) => formatChordSymbol(symbol(text), { noteNames: 'solfege' })
    expect(solfege('Am')).toBe('Lam')
    expect(solfege('F#m7')).toBe('Fa#m7')
    expect(solfege('Bb/D')).toBe('Sib/Re')
    expect(solfege('G7sus4')).toBe('Sol7sus4')
    expect(solfege('Cmaj7')).toBe('Domaj7')
  })

  it('spells roots and basses', () => {
    expect(formatChordSymbol(symbol('A#m/C#'), { spelling: 'flat' })).toBe('Bbm/Db')
    expect(formatChordSymbol(symbol('Bbm/Db'), { spelling: 'sharp' })).toBe('A#m/C#')
    // The bass is spelled from the root's letter: the third of E is G#, not Ab.
    expect(formatChordSymbol(symbol('E/Ab'))).toBe('E/G#')
    expect(formatChordSymbol(symbol('B/Eb'))).toBe('B/D#')
    expect(formatChordSymbol(symbol('Am/Ab'))).toBe('Am/G#')
    expect(formatChordSymbol(symbol('C/Bb'))).toBe('C/Bb')
    expect(formatChordSymbol(symbol('Cdim7/A'))).toBe('Cdim7/A')
    expect(formatChordSymbol(symbol('Gb/Bb'), { spelling: 'flat' })).toBe('Gb/Bb')
    expect(formatChordSymbol(symbol('C#/F'), { spelling: 'sharp' })).toBe('C#/E#')
    // A double accidental (F## for the G under C#) falls back to the plain spelling.
    expect(formatChordSymbol(symbol('C#/G'), { spelling: 'sharp' })).toBe('C#/G')
    // Chromatic diminished chords are leading-tone chords, spelled with sharps.
    expect(formatChordSymbol(symbol('Abdim'))).toBe('G#dim')
    expect(formatChordSymbol(symbol('Ebdim7'))).toBe('D#dim7')
    expect(formatChordSymbol(symbol('Ebdim7'), { spelling: 'flat' })).toBe('Ebdim7')
    expect(formatChordSymbol(symbol('Ebm7b5'))).toBe('Ebm7b5')
  })

  it('round-trips every interval set and slash bass through format → parse', () => {
    for (const mask of ALL_MASKS) {
      for (const bass of [null, 0, 2, 4, 10]) {
        const c = makeChord(0, mask, bass)
        const text = formatChordSymbol(c)
        expect(tryParseChordSymbol(text), `${text} (mask ${mask.toString(2)})`).toEqual(c)
      }
    }
  })

  test.prop([anyChord, fc.constantFrom(...SPELLINGS)])(
    'format → parse is lossless for any root, bass and spelling',
    (c, spelling) => {
      expect(tryParseChordSymbol(formatChordSymbol(c, { spelling }))).toEqual(c)
    },
  )

  test.prop([fc.constantFrom(...CORPUS.map(([s]) => s))])('formatting is idempotent', (s) => {
    const once = formatChordSymbol(symbol(s))
    expect(formatChordSymbol(symbol(once))).toBe(once)
  })
})

describe('Harte labels', () => {
  it('parses shorthands, degree lists, omissions and bass degrees', () => {
    expect(harte('C')).toEqual(symbol('C'))
    expect(harte('C/5')).toEqual(symbol('C/G'))
    expect(harte('G:7/3')).toEqual(symbol('G7/B'))
    expect(harte('E:min7(*5)')).toEqual(makeChord(4, [0, 3, 10]))
    expect(harte('D:(1,b3,5)')).toEqual(symbol('Dm'))
    expect(harte('C:sus4(b7)')).toEqual(symbol('C7sus4'))
    expect(harte('A:13')).toEqual(makeChord(9, [0, 4, 7, 10, 2, 5, 9]))
    expect(harte('C:maj( 9 , )')).toEqual(symbol('Cadd9'))
    expect(harte('Cb:maj')).toEqual(symbol('B'))
    expect(harte('C#:min/b3')).toEqual(symbol('C#m/E'))
    expect(parseHarte('N')).toEqual({ kind: 'no-chord' })
    expect(parseHarte(' X ')).toEqual({ kind: 'no-chord' })
  })

  it.each(['C:foo', 'C:', 'H:maj', 'C:maj(z)', 'C:maj/x', 'Am', 'C:maj/14', 'C:(1,3,q5)'])(
    'rejects %j',
    (bad) => {
      expect(parseHarte(bad)).toBeNull()
    },
  )

  it('formats with base shorthands plus extra degrees', () => {
    const cases: [string, string][] = [
      ['C', 'C:maj'],
      ['Am7', 'A:min7'],
      ['F#m7b5', 'F#:hdim7'],
      ['C9', 'C:7(9)'],
      ['C7sus4', 'C:sus4(b7)'],
      ['Csus2', 'C:sus2'],
      ['Cdim7', 'C:dim7'],
      ['C6', 'C:maj6'],
      ['C13', 'C:7(9,13)'],
      ['C7#9', 'C:7(#9)'],
      ['C(b5)', 'C:(1,3,b5)'],
      ['Caug', 'C:aug'],
      ['Cmaj7#5', 'C:aug(7)'],
      ['C5', 'C:5'],
      ['Cno3no5', 'C:1'],
      ['C/E', 'C:maj/3'],
      ['Am/G', 'A:min/b7'],
      ['Cm(#5)', 'C:(1,b3,#5)'],
    ]
    for (const [input, expected] of cases) expect(formatHarte(symbol(input)), input).toBe(expected)
    expect(formatHarte(symbol('Bbmaj7'), 'flat')).toBe('Bb:maj7')
  })

  it('round-trips every interval set through format → parse', () => {
    for (const mask of ALL_MASKS) {
      for (const bass of [null, 3, 11]) {
        const c = makeChord(0, mask, bass)
        expect(harte(formatHarte(c)), formatHarte(c)).toEqual(c)
      }
    }
  })
})
