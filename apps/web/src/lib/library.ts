/**
 * The song library: analyzed songs kept in the browser's IndexedDB. There are no accounts; the
 * server deletes its copy after a few hours, so everything needed to play along offline (the
 * analysis, the audio, the user's corrections and view settings) lives here.
 */
import type { AnalysisResult, JobSource } from '@barrefree/contracts'
import type { Mode } from '@barrefree/theory'
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'

import type { ChordDisplay } from './arrangement'

export interface SongView {
  mode: Mode
  lambdaIndex: number
  noCapo: boolean
  capo: number | null
  shift: number
  display: ChordDisplay
}

export interface SongRecord {
  id: string
  title: string
  createdAt: number
  source: JobSource
  analysis: AnalysisResult
  /** Corrected chord per chord-segment index: Harte at the recording's pitch, "N" for none. */
  edits: Record<number, string>
  view?: SongView
}

/** What the library list needs, without the analysis. */
export type SongSummary = Pick<SongRecord, 'id' | 'title' | 'createdAt'> & {
  durationSec: number
  key: AnalysisResult['key']
}

interface LibrarySchema extends DBSchema {
  songs: { key: string; value: SongRecord; indexes: { createdAt: number } }
  audio: { key: string; value: Blob }
}

const DB_NAME = 'barrefree'
const DB_VERSION = 1
let opening: Promise<IDBPDatabase<LibrarySchema>> | null = null

function db(): Promise<IDBPDatabase<LibrarySchema>> {
  if (!opening) {
    // async: a synchronous throw (IndexedDB blocked by the browser) becomes a rejection too.
    const pending = (async () =>
      openDB<LibrarySchema>(DB_NAME, DB_VERSION, {
        upgrade(database) {
          const songs = database.createObjectStore('songs', { keyPath: 'id' })
          songs.createIndex('createdAt', 'createdAt')
          // Audio blobs in their own store, so listing songs never loads megabytes of audio.
          database.createObjectStore('audio')
        },
      }))()
    // A failed open is not cached: the next call tries again.
    pending.catch(() => {
      if (opening === pending) opening = null
    })
    opening = pending
  }
  return opening
}

/** The browser refused to store more (the library or the disk is full). */
export function isQuotaError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'QuotaExceededError'
}

/** Closes the connection (tests delete the database between runs). */
export async function closeLibrary(): Promise<void> {
  if (opening) (await opening).close()
  opening = null
}

/**
 * Adds a song with its audio, unless a song with this id is already saved: that one may carry
 * the user's fixes and must not be replaced. Returns whether the song was added.
 */
export async function saveSong(song: SongRecord, audio?: Blob): Promise<boolean> {
  const database = await db()
  const tx = database.transaction(['songs', 'audio'], 'readwrite')
  const songs = tx.objectStore('songs')
  if ((await songs.getKey(song.id)) !== undefined) {
    await tx.done
    return false
  }
  await songs.add(song)
  if (audio) await tx.objectStore('audio').put(audio, song.id)
  await tx.done
  return true
}

export async function getSong(id: string): Promise<SongRecord | undefined> {
  return (await db()).get('songs', id)
}

export async function getAudio(id: string): Promise<Blob | undefined> {
  return (await db()).get('audio', id)
}

export async function listSongs(): Promise<SongSummary[]> {
  const songs = await (await db()).getAllFromIndex('songs', 'createdAt')
  return songs.reverse().map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    durationSec: s.analysis.durationSec,
    key: s.analysis.key,
  }))
}

export async function updateSong(
  id: string,
  patch: Partial<Pick<SongRecord, 'title' | 'edits' | 'view'>>,
): Promise<SongRecord | undefined> {
  const database = await db()
  const tx = database.transaction('songs', 'readwrite')
  const current = await tx.store.get(id)
  if (!current) {
    await tx.done
    return undefined
  }
  const next = { ...current, ...patch }
  await tx.store.put(next)
  await tx.done
  return next
}

export async function deleteSong(id: string): Promise<void> {
  const database = await db()
  const tx = database.transaction(['songs', 'audio'], 'readwrite')
  await tx.objectStore('songs').delete(id)
  await tx.objectStore('audio').delete(id)
  await tx.done
}
