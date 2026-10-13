import { describe, expect, it } from 'vitest'

import { labelFromFrame, labelInFrame } from './edits'

describe('chord fixes in the chart frame', () => {
  const capo2 = { offset: -2, spelling: 'sharp' as const }

  it('shows stored labels the way the chart writes chords', () => {
    expect(labelInFrame('A:min', { offset: 0, spelling: 'neutral' })).toBe('Am')
    // Capo 2 shapes: the recorded A minor is played as a G minor shape.
    expect(labelInFrame('A:min', capo2)).toBe('Gm')
    expect(labelInFrame('A:min', capo2, 'solfege')).toBe('Solm')
    expect(labelInFrame('N', capo2)).toBe('N.C.')
    expect(labelInFrame('not a chord', capo2)).toBe('not a chord')
  })

  it('stores what was typed as canonical Harte at the recording pitch', () => {
    expect(labelFromFrame('Gm', capo2)).toBe('A:min')
    expect(labelFromFrame('C', { offset: 0, spelling: 'neutral' })).toBe('C:maj')
    expect(labelFromFrame('C:maj', { offset: 0, spelling: 'neutral' })).toBe('C:maj')
    expect(labelFromFrame('n.c.', capo2)).toBe('N')
    expect(labelFromFrame('Xyz', capo2)).toBeNull()
  })
})
