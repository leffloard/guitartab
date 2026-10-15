import type { ChartBar, TimedChord } from '@barrefree/theory'
import { render, screen } from '@testing-library/react'
import i18n from 'i18next'
import { beforeEach, describe, expect, it } from 'vitest'

import { ChordChart } from './ChordChart'

const chords: TimedChord[] = [
  { start: 0, end: 3, label: 'F:maj7', confidence: 1 },
  { start: 3, end: 4, label: 'C:maj', confidence: 1 },
  { start: 4, end: 5, label: 'G:maj', confidence: 1 },
]
const names = ['Fmaj7', 'C', 'G']
const beats = (start: number) => [start, start + 0.5, start + 1, start + 1.5]
const bars: ChartBar[] = [
  // One chord for the whole bar.
  {
    start: 0,
    end: 2,
    beats: beats(0),
    chords: [{ index: 0, beat: 0, carried: false, rest: false }],
  },
  // Carried over, then a new chord on beat 3.
  {
    start: 2,
    end: 4,
    beats: beats(2),
    chords: [
      { index: 0, beat: 0, carried: true, rest: false },
      { index: 1, beat: 2, carried: false, rest: false },
    ],
  },
  // Two chords, on beats 1 and 2.
  {
    start: 4,
    end: 6,
    beats: beats(4),
    chords: [
      { index: 1, beat: 0, carried: false, rest: false },
      { index: 2, beat: 1, carried: false, rest: false },
    ],
  },
]

function renderChart(chartBars: ChartBar[] = bars) {
  return render(
    <ChordChart
      bars={chartBars}
      chords={chords}
      nameOf={(i) => names[i] ?? null}
      currentBar={-1}
      currentChord={-1}
      threshold={0.5}
      isEdited={() => false}
      isChanged={() => false}
      editing={false}
      onSeek={() => undefined}
      onEdit={() => undefined}
    />,
  )
}

describe('chord chart', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('lets each chord run until the next one starts, so its name is not cut to one beat', () => {
    const { container } = renderChart()
    const [first, second, third] = screen.getAllByRole('listitem')
    const columns = (bar: HTMLElement | undefined) =>
      [...(bar?.querySelectorAll<HTMLElement>('button, .held') ?? [])].map((el) => [
        el.textContent,
        el.style.gridColumn,
      ])

    expect(columns(first)).toEqual([['Fmaj7', '1 / 5']])
    expect(columns(second)).toEqual([
      ['Fmaj7', '1 / 3'],
      ['C', '3 / 5'],
    ])
    expect(columns(third)).toEqual([
      ['C', '1 / 2'],
      ['G', '2 / 5'],
    ])
    expect(container.querySelectorAll('.held')).toHaveLength(1)
    // Beats keep equal columns, so a chord's position still shows its beat.
    expect(first?.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))')
    expect(container.querySelector('.chart')).not.toHaveClass('is-dense')
  })

  it('widens every bar when a long name sits on a single beat', () => {
    const quick: ChartBar = {
      start: 0,
      end: 2,
      beats: beats(0),
      chords: [
        { index: 1, beat: 0, carried: false, rest: false },
        { index: 0, beat: 1, carried: false, rest: false },
        { index: 2, beat: 2, carried: false, rest: false },
      ],
    }
    const { container } = renderChart([quick])
    expect(screen.getByRole('button', { name: 'Fmaj7' }).style.gridColumn).toBe('2 / 3')
    expect(container.querySelector('.chart')).toHaveClass('is-dense')
  })
})
