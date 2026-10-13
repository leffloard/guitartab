import { describe, expect, it } from 'vitest'

import { parseRoute } from './router'

describe('parseRoute', () => {
  it('maps paths to routes', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' })
    expect(parseRoute('/library/')).toEqual({ name: 'library' })
    expect(parseRoute('/jobs/abc_DEF-1')).toEqual({ name: 'job', id: 'abc_DEF-1' })
    expect(parseRoute('/songs/xyz')).toEqual({ name: 'song', id: 'xyz' })
    expect(parseRoute('/songs/a/b')).toEqual({ name: 'not-found' })
    expect(parseRoute('/jobs/../etc')).toEqual({ name: 'not-found' })
  })
})
