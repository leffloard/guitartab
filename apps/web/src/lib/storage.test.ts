import { afterEach, describe, expect, it, vi } from 'vitest'

import { readStored, writeStored } from './storage'

const isNumber = (v: unknown): v is number => typeof v === 'number'

describe('storage helpers', () => {
  afterEach(() => vi.restoreAllMocks())

  it('round-trips JSON and validates what it reads', () => {
    writeStored('k', 3)
    expect(readStored('k', 0, isNumber)).toBe(3)
    localStorage.setItem('k', '"text"')
    expect(readStored('k', 0, isNumber)).toBe(0)
    localStorage.setItem('k', '{broken')
    expect(readStored('k', 7, isNumber)).toBe(7)
    writeStored('k', undefined)
    expect(localStorage.getItem('k')).toBeNull()
  })

  it('never throws when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readStored('k', 1, isNumber)).toBe(1)
    expect(() => writeStored('k', 2)).not.toThrow()
  })
})
