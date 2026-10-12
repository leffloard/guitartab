import chordsDb from '../standard/chords-db.json' with { type: 'json' }
import curated from '../standard/curated.json' with { type: 'json' }

/** One chord shape as stored on disk (see schema/voicing-library.schema.json). */
export interface VoicingRecord {
  /** Chord symbol, e.g. "Fmaj7" or "C/E". */
  chord: string
  /** Index 0 = low E string. Frets relative to the nut or capo; null = muted, 0 = open. */
  frets: (number | null)[]
  /** 1 = index … 4 = pinky; null = open, muted or unknown. Missing = derive automatically. */
  fingers?: (number | null)[]
  note?: string
}

export interface VoicingLibraryFile {
  tuning: 'standard'
  source?: { name: string; url: string; commit: string; license: string }
  voicings: VoicingRecord[]
}

/**
 * Standard-tuning libraries, in priority order: when two files contain the same frets,
 * the earlier file's entry (name and fingering) wins.
 */
export const STANDARD_LIBRARIES: readonly VoicingLibraryFile[] = [
  curated as VoicingLibraryFile,
  chordsDb as VoicingLibraryFile,
]
