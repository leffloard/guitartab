import Ajv2020 from 'ajv/dist/2020.js'
import { describe, expect, it } from 'vitest'

import schema from '../schema/voicing-library.schema.json' with { type: 'json' }
import { STANDARD_LIBRARIES } from './index.ts'

describe('voicing library files', () => {
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema)

  it.each(STANDARD_LIBRARIES.map((lib, i) => [i, lib] as const))(
    'file %i matches the JSON Schema',
    (_i, lib) => {
      expect(validate(lib), JSON.stringify(validate.errors, null, 2)).toBe(true)
    },
  )

  it('has fingers only on fretted strings', () => {
    for (const lib of STANDARD_LIBRARIES) {
      for (const v of lib.voicings) {
        v.fingers?.forEach((finger, i) => {
          const fret = v.frets[i]
          if (finger !== null) expect(fret, `${v.chord} ${String(v.frets)}`).toBeGreaterThan(0)
        })
      }
    }
  })

  it('records the provenance of the imported chords-db data', () => {
    const imported = STANDARD_LIBRARIES.find((lib) => lib.source)
    expect(imported?.source?.name).toBe('tombatossals/chords-db')
    expect(imported?.voicings.length).toBeGreaterThan(2500)
  })
})
