import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import schema from '../schema/analysis.schema.json' with { type: 'json' }
import type { AnalysisResult } from './index.ts'

const example: AnalysisResult = {
  version: 1,
  durationSec: 213.4,
  tempoBpm: 92,
  timeSignature: '4/4',
  key: { tonic: 'A', mode: 'minor', confidence: 0.71 },
  beats: [0.52, 1.17],
  downbeats: [0.52],
  chords: [{ start: 0.52, end: 3.1, label: 'A:min', confidence: 0.83 }],
  notes: [{ start: 1, end: 1.4, midi: 64, velocity: 0.7 }],
  meta: { recognizer: 'chordino', separated: true, processingSec: 48.2 },
}

describe('analysis schema', () => {
  const validate = new Ajv2020({ strict: false }).compile(schema)

  it('accepts the documented example', () => {
    expect(validate(example), JSON.stringify(validate.errors)).toBe(true)
  })

  it('rejects unknown fields', () => {
    expect(validate({ ...example, extra: 1 })).toBe(false)
  })
})
