import { useCallback, useState } from 'react'

import { readStored, writeStored } from '../lib/storage'

const KEY = 'barrefree.voicings'

type Preferences = Record<string, string>

function isPreferences(v: unknown): v is Preferences {
  return (
    typeof v === 'object' &&
    v !== null &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
  )
}

/**
 * The shape the user picked for a chord, remembered across songs. Keyed by the chord to fret
 * (shape space) and the mode, so "my Fmaj7 for F" applies wherever that shape is needed.
 */
export function useVoicingPreferences(): [
  Preferences,
  (key: string, voicingId: string | null) => void,
] {
  const [prefs, setPrefs] = useState<Preferences>(() => readStored(KEY, {}, isPreferences))
  const set = useCallback((key: string, voicingId: string | null) => {
    setPrefs((prev) => {
      const next = { ...prev }
      if (voicingId === null) delete next[key]
      else next[key] = voicingId
      writeStored(KEY, next)
      return next
    })
  }, [])
  return [prefs, set]
}
