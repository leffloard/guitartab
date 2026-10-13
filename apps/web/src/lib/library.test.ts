import { Blob as NodeBlob } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { song } from '../test/fixtures'
import { deleteSong, getAudio, getSong, listSongs, saveSong, updateSong } from './library'

describe('song library (IndexedDB)', () => {
  it('saves, lists newest first, updates and deletes songs with their audio', async () => {
    // fake-indexeddb clones with Node's structuredClone, which keeps Node Blobs (browsers keep theirs).
    await saveSong(song('a'), new NodeBlob(['aaa'], { type: 'audio/mp4' }) as unknown as Blob)
    await saveSong({ ...song('b'), title: 'Second', createdAt: song().createdAt + 1 })
    expect((await listSongs()).map((s) => s.id)).toEqual(['b', 'a'])
    expect((await listSongs())[1]).toMatchObject({ title: 'Test Song', durationSec: 16 })
    expect((await getAudio('a'))?.size).toBe(3)

    await updateSong('a', { edits: { 3: 'Fmaj7' } })
    expect((await getSong('a'))?.edits).toEqual({ 3: 'Fmaj7' })
    expect(await updateSong('missing', { title: 'x' })).toBeUndefined()

    // Saving the same song again (its job page opened twice) never replaces the user's fixes.
    expect(await saveSong({ ...song('a'), title: 'Replaced' })).toBe(false)
    expect((await getSong('a'))?.title).toBe('Test Song')
    expect((await getSong('a'))?.edits).toEqual({ 3: 'Fmaj7' })

    await deleteSong('a')
    expect(await getSong('a')).toBeUndefined()
    expect(await getAudio('a')).toBeUndefined()
    expect((await listSongs()).map((s) => s.id)).toEqual(['b'])
  })
})
