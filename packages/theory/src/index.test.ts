import { test } from '@fast-check/vitest'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { mod12 } from './index'

describe('mod12', () => {
  it('wraps negative numbers', () => {
    expect(mod12(-1)).toBe(11)
    expect(mod12(12)).toBe(0)
  })

  test.prop([fc.integer({ min: -1000, max: 1000 })])('always returns 0..11', (n) => {
    const pc = mod12(n)
    expect(pc).toBeGreaterThanOrEqual(0)
    expect(pc).toBeLessThan(12)
    expect(mod12(n + 12)).toBe(pc)
  })
})
