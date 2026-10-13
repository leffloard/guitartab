import type { AnalysisResult } from '@barrefree/contracts'

import type { SongRecord } from '../lib/library'

/** A 16-second analysis at 120 BPM in 4/4: C | G Am | F (uncertain) | C. */
export function analysis(): AnalysisResult {
  const beats = Array.from({ length: 32 }, (_, i) => 0.5 * i)
  return {
    version: 1,
    durationSec: 16,
    tempoBpm: 120,
    timeSignature: '4/4',
    key: { tonic: 'C', mode: 'major', confidence: 0.8 },
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
    chords: [
      { start: 0, end: 2, label: 'C:maj', confidence: 0.9 },
      { start: 2, end: 3, label: 'G:maj', confidence: 0.9 },
      { start: 3, end: 4, label: 'A:min', confidence: 0.8 },
      { start: 4, end: 6, label: 'F:maj', confidence: 0.3 },
      { start: 6, end: 16, label: 'C:maj', confidence: 0.9 },
    ],
    notes: [],
    meta: { recognizer: 'chordino', separated: false, processingSec: 1 },
  }
}

export function song(id = 'song1'): SongRecord {
  return {
    id,
    title: 'Test Song',
    createdAt: 1_700_000_000_000,
    source: { kind: 'upload', name: 'test.wav', url: null },
    analysis: analysis(),
    edits: {},
  }
}
