import { useCallback, useState } from 'react'

import { readStored, writeStored } from '../lib/storage'

export type NoteNames = 'letter' | 'solfege'

export interface Settings {
  /** Chord names as C D E or Do Re Mi. */
  noteNames: NoteNames
  /** Keep the screen awake while a song is shown. */
  keepScreenOn: boolean
}

const KEY = 'barrefree.settings'
const DEFAULTS: Settings = { noteNames: 'letter', keepScreenOn: true }

function isSettings(v: unknown): v is Settings {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Record<string, unknown>
  return (
    (s.noteNames === 'letter' || s.noteNames === 'solfege') && typeof s.keepScreenOn === 'boolean'
  )
}

export function useSettings(): [Settings, (patch: Partial<Settings>) => void] {
  const [settings, setSettings] = useState<Settings>(() => readStored(KEY, DEFAULTS, isSettings))
  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      writeStored(KEY, next)
      return next
    })
  }, [])
  return [settings, update]
}
