import { test } from '@fast-check/vitest'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  expandTabs,
  isChordToken,
  parseChordSheet,
  renderChordSheet,
  renderedToText,
  sheetProgression,
  toChordPro,
  type ChordToken,
} from '../src/sheet.ts'
import { formatChordSymbol } from '../src/symbol.ts'
import { transform } from '../src/transform.ts'

// Original placeholder lyrics: the repository must never contain copyrighted song text.
const SHEET = `[Verse 1]
F           C            G       Am
Walking down the river in the morning light
F         C         G
Counting every stone along the way

Chorus:
Bb    F/A    Gm7   C7sus4
Oh la la la, sing it again
e|-----0---1---|
N.C.        Am  |  F  (x2)
`

const kinds = (text: string) => parseChordSheet(text).lines.map((l) => l.kind)

describe('chord sheet parsing', () => {
  it('classifies lines of a chords-over-lyrics sheet', () => {
    const sheet = parseChordSheet(SHEET)
    expect(sheet.format).toBe('chords-over-lyrics')
    expect(sheet.lines.map((l) => l.kind)).toEqual([
      'section',
      'chords',
      'lyrics',
      'chords',
      'lyrics',
      'blank',
      'section',
      'chords',
      'lyrics',
      'tab',
      'chords',
      'blank',
    ])
    expect(sheetProgression(sheet).map((p) => p.label)).toEqual([
      'F',
      'C',
      'G',
      'Am',
      'F',
      'C',
      'G',
      'Bb',
      'F/A',
      'Gm7',
      'C7sus4',
      'N.C.',
      'Am',
      'F',
    ])
  })

  it('keeps lyrics that happen to start with chord names as lyrics', () => {
    expect(kinds('A man a plan')).toEqual(['lyrics'])
    expect(kinds('Am I wrong')).toEqual(['lyrics'])
    expect(kinds('E')).toEqual(['chords'])
    expect(kinds('Bm  G  D  A  repeat')).toEqual(['chords'])
    expect(kinds('Bm  G  D  A  please')).toEqual(['chords'])
    expect(kinds('Bm  G  D  please')).toEqual(['lyrics'])
    expect(kinds('Intro:  Am  G')).toEqual(['chords'])
    expect(kinds('Nakarat:')).toEqual(['section'])
    expect(kinds('(Solo x2)')).toEqual(['section'])
    expect(kinds('[Am]')).toEqual(['section'])
    expect(kinds('  (Am)   (G)')).toEqual(['chords'])
    expect(kinds('A:min  G:maj')).toEqual(['chords'])
  })

  it('detects ChordPro and reads directives and inline chords', () => {
    const sheet = parseChordSheet(
      '{title: Morning}\n{artist: Nobody}\n{capo: 2}\n{key: G}\n[G]Walking [D/F#]down the [Em]river\n[Verse]\n',
    )
    expect(sheet.format).toBe('chordpro')
    expect(sheet.meta).toEqual({ title: 'Morning', artist: 'Nobody', capo: 2, key: 'G' })
    const inline = sheet.lines.find((l) => l.kind === 'inline')
    expect(inline).toMatchObject({ lyrics: 'Walking down the river' })
    if (inline?.kind === 'inline') expect(inline.chords.map((c) => c.column)).toEqual([0, 8, 17])
    expect(sheet.lines.at(-2)?.kind).toBe('section')
    expect(parseChordSheet('{capo: two}').meta.capo).toBeUndefined()
    expect(parseChordSheet('[Verse] some [Xyz] text').format).toBe('chords-over-lyrics')
    expect(parseChordSheet('[C] [G]').format).toBe('chordpro')
  })

  it('expands tabs to 8-column stops', () => {
    expect(expandTabs('a\tb')).toBe('a       b')
    expect(expandTabs('abcdefgh\tx')).toBe('abcdefgh        x')
    expect(parseChordSheet('C\tG').lines[0]).toMatchObject({ kind: 'chords', text: 'C       G' })
  })
})

describe('chord sheet rendering', () => {
  const identity = (t: ChordToken) => t.text

  it('renders unchanged with the identity replacer', () => {
    const sheet = parseChordSheet(SHEET)
    expect(renderedToText(renderChordSheet(sheet, identity))).toBe(SHEET)
  })

  it('keeps chords in their columns and lyrics untouched', () => {
    const sheet = parseChordSheet('F     C\nla la la la la\n')
    const lines = renderChordSheet(sheet, (t) => (t.text === 'F' ? 'Fmaj7' : t.text))
    expect(lines[0]?.text).toBe('Fmaj7 C')
    expect(lines[0]?.chords.map((c) => [c.start, c.end])).toEqual([
      [0, 5],
      [6, 7],
    ])
    expect(lines[1]?.text).toBe('la la la la la')
  })

  it('pushes a following chord right only when a longer name reaches it', () => {
    const sheet = parseChordSheet('F  C   G\n')
    const lines = renderChordSheet(sheet, (t) => (t.text === 'F' ? 'Fmaj7' : t.text))
    expect(lines[0]?.text).toBe('Fmaj7 C G')
  })

  test.prop([
    fc.array(
      fc.record({
        gap: fc.integer({ min: 1, max: 6 }),
        name: fc.constantFrom('C', 'Am', 'F', 'G7', 'Bb', 'F#m7b5', 'D/F#', 'N.C.', '|'),
      }),
      { minLength: 1, maxLength: 8 },
    ),
    fc.constantFrom('X', 'Xmaj13#11', 'Ym'),
  ])('chords keep their order and never move left of their column', (cells, replacement) => {
    let line = ''
    for (const { gap, name } of cells) line += ' '.repeat(line ? gap : gap - 1) + name
    const sheet = parseChordSheet(line)
    const original = sheet.lines[0]
    if (original?.kind !== 'chords') return
    const rendered = renderChordSheet(sheet, () => replacement)[0]
    const chordItems = original.items.filter((p) => isChordToken(p.item))
    expect(rendered?.chords).toHaveLength(chordItems.length)
    rendered?.chords.forEach((c, i) => {
      expect(c.start).toBeGreaterThanOrEqual(chordItems[i]?.column ?? 0)
      expect(rendered.text.slice(c.start, c.end)).toBe(replacement)
      if (i > 0) expect(c.start).toBeGreaterThan(rendered.chords[i - 1]?.end ?? 0)
    })
  })

  it('shows ChordPro lines as chords over lyrics and exports ChordPro back', () => {
    const sheet = parseChordSheet('{title: Morning}\n[G]Walking [D/F#]down the [Em]river\n')
    const lines = renderChordSheet(sheet, identity)
    expect(lines.slice(1).map((l) => l.text)).toEqual([
      'G       D/F#     Em',
      'Walking down the river',
      '',
    ])
    expect(toChordPro(sheet, identity)).toBe(
      '{title: Morning}\n[G]Walking [D/F#]down the [Em]river\n',
    )
  })

  it('exports a chords-over-lyrics sheet as ChordPro with a capo', () => {
    const sheet = parseChordSheet('[Verse]\nF     C\nla la la\n\nG  Am\n')
    expect(toChordPro(sheet, identity, { capo: 3, title: 'Song' })).toBe(
      '{title: Song}\n{capo: 3}\n{comment: Verse}\n[F]la la [C]la\n\n[G] [Am]\n',
    )
  })
})

describe('end to end: a pasted sheet becomes barre-free', () => {
  it('replaces F and Bm and keeps the alignment', () => {
    const text = `F        C          G         Am\nOne two three four five six seven\nBm       G          D         A\nEight nine ten eleven twelve\n`
    const sheet = parseChordSheet(text)
    const result = transform(sheetProgression(sheet), { mode: 'easy' })
    const lines = renderChordSheet(sheet, (t) => {
      const item = result.items[t.index]
      return item?.choice ? formatChordSymbol(item.choice.played) : t.text
    })
    const out = renderedToText(lines)
    expect(result.option?.fullBarres).toBe(0)
    expect(out).toContain('Fmaj7')
    expect(out).toContain('Bm7')
    // Lyrics unchanged, chords still start at their original columns.
    expect(lines[1]?.text).toBe('One two three four five six seven')
    expect(lines[0]?.chords.map((c) => c.start)).toEqual([0, 9, 20, 30])
    expect(lines[2]?.chords.map((c) => c.start)).toEqual([0, 9, 20, 30])
  })
})
