import { makeVoicing } from '@barrefree/theory'
import { describe, expect, it } from 'vitest'

import { toSvguitar } from './diagram'

const x = null

describe('toSvguitar', () => {
  it('numbers strings from the high E and keeps open and muted strings', () => {
    const fmaj7 = makeVoicing([x, x, 3, 2, 1, 0], [x, x, 3, 2, 1, x], 'test')
    expect(toSvguitar(fmaj7, 'Fmaj7')).toEqual({
      fingers: [
        [6, 'x'],
        [5, 'x'],
        [4, 3, '3'],
        [3, 2, '2'],
        [2, 1, '1'],
        [1, 0],
      ],
      barres: [],
      position: 1,
      title: 'Fmaj7',
    })
  })

  it('draws barres as one bar and shifts high shapes to their position', () => {
    const bm = makeVoicing([x, 7, 9, 9, 8, 7], [x, 1, 3, 4, 2, 1], 'test')
    const chart = toSvguitar(bm)
    expect(chart.position).toBe(7)
    expect(chart.barres).toEqual([{ fromString: 5, toString: 1, fret: 1, text: '1' }])
    expect(chart.fingers).toEqual([
      [6, 'x'],
      [4, 3, '3'],
      [3, 3, '4'],
      [2, 2, '2'],
    ])
    expect(toSvguitar(makeVoicing([0, 0, 0, 0, 0, 0], [x, x, x, x, x, x], 't')).position).toBe(1)
    expect(toSvguitar(makeVoicing([x, 3, 5, 5, x, x], [x, x, x, x, x, x], 't')).fingers).toEqual([
      [6, 'x'],
      [5, 1],
      [4, 3],
      [3, 3],
      [2, 'x'],
      [1, 'x'],
    ])
  })
})
