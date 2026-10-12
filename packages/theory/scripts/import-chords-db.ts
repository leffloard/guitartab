// Converts tombatossals/chords-db (MIT) into data/voicings/standard/chords-db.json.
//
//   curl -sSfLo /tmp/guitar.json \
//     https://raw.githubusercontent.com/tombatossals/chords-db/<COMMIT>/lib/guitar.json
//   node packages/theory/scripts/import-chords-db.ts /tmp/guitar.json
//
// chords-db stores frets relative to `baseFret` (-1 = muted). We convert them to absolute frets,
// check every position against the MIDI notes chords-db lists for it, and keep only shapes whose
// sounding notes are consistent with their chord name according to our own parser.
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import { describe, pitchClassesOf } from '../src/chord.ts'
import { mod12 } from '../src/pitch.ts'
import { parseChordSymbol } from '../src/symbol.ts'
import { STANDARD } from '../src/tuning.ts'
import { playedNotes, soundingMidi, type Finger, type Fret } from '../src/voicing.ts'

const COMMIT = 'df06fa7b425cf5fd29485ff6591236b3557e3fac'
const SHA256 = 'cfe439962b2f444d2c341b1f0261403b4c3a3416e321147286fc608922699974'
const OUT = new URL('../../../data/voicings/standard/chords-db.json', import.meta.url)

/** chords-db suffix → chord-symbol suffix understood by parseChordSymbol (null = skip). */
const SUFFIX: Readonly<Record<string, string | null>> = {
  major: '',
  minor: 'm',
  sus: 'sus4',
  '69': '6/9',
  m69: 'm6/9',
  alt: null, // "altered" has no single agreed pitch set
}

interface Position {
  frets: number[]
  fingers: number[]
  baseFret: number
  midi: number[]
}
interface ChordEntry {
  key: string
  suffix: string
  positions: Position[]
}
interface ChordsDb {
  chords: Record<string, ChordEntry[]>
}

const [, , inputPath] = process.argv
if (!inputPath)
  throw new Error('usage: node import-chords-db.ts <path to chords-db lib/guitar.json>')
const raw = await readFile(inputPath)
const digest = createHash('sha256').update(raw).digest('hex')
if (digest !== SHA256)
  throw new Error(`unexpected guitar.json (sha256 ${digest}); expected commit ${COMMIT}`)
const db = JSON.parse(raw.toString('utf8')) as ChordsDb

const voicings: { chord: string; frets: Fret[]; fingers?: Finger[] }[] = []
const skipped: Record<string, number> = {}
const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1)

for (const entries of Object.values(db.chords)) {
  for (const entry of entries) {
    const suffix = entry.suffix in SUFFIX ? SUFFIX[entry.suffix] : entry.suffix
    if (suffix === null || suffix === undefined) {
      skip(`suffix ${entry.suffix}`)
      continue
    }
    const symbol = entry.key + suffix
    const parsed = parseChordSymbol(symbol)
    if (!parsed.ok) {
      skip(`unparsable ${symbol}`)
      continue
    }
    const chord = parsed.chord
    const allowed = new Set<number>(pitchClassesOf(chord))
    if (chord.bass !== null) allowed.add(chord.bass)
    const s = describe(chord)
    const seen = new Set<string>()

    for (const p of entry.positions) {
      const frets: Fret[] = p.frets.map((f) => (f < 0 ? null : f === 0 ? 0 : f + p.baseFret - 1))
      const midi = soundingMidi(frets).filter((m): m is number => m !== null)
      if (midi.join() !== p.midi.join()) {
        skip('midi mismatch')
        continue
      }
      const id = frets.join()
      if (seen.has(id)) {
        skip('duplicate')
        continue
      }
      const played = playedNotes(frets, STANDARD)
      const pcs = new Set<number>(played.pcs)
      const thirdOk =
        s.third === null ||
        pcs.has(
          mod12(
            chord.root + (s.third === 'M3' ? 4 : s.third === 'm3' ? 3 : s.third === 'sus2' ? 2 : 5),
          ),
        )
      const consistent =
        [...pcs].every((pc) => allowed.has(pc)) &&
        pcs.has(chord.root) &&
        thirdOk &&
        played.lowest === (chord.bass ?? played.lowest) &&
        played.pcs.length >= 3
      if (!consistent) {
        skip('notes inconsistent with name')
        continue
      }
      seen.add(id)
      let fingers: Finger[] | undefined = p.fingers.map((f, i) =>
        frets[i] !== null && (frets[i] ?? 0) > 0 && f > 0 ? f : null,
      )
      // Drop fingerings that put one finger on two different frets.
      const fretOfFinger = new Map<number, number>()
      for (let i = 0; i < 6; i++) {
        const finger = fingers[i]
        const fret = frets[i]
        if (finger == null || fret == null) continue
        if ((fretOfFinger.get(finger) ?? fret) !== fret) {
          fingers = undefined
          skip('fingering dropped (one finger on two frets)')
          break
        }
        fretOfFinger.set(finger, fret)
      }
      if (fingers?.some((f, i) => f === null && (frets[i] ?? 0) > 0)) fingers = undefined
      voicings.push(fingers ? { chord: symbol, frets, fingers } : { chord: symbol, frets })
    }
  }
}

const file = {
  $schema: '../schema/voicing-library.schema.json',
  tuning: 'standard',
  source: {
    name: 'tombatossals/chords-db',
    url: 'https://github.com/tombatossals/chords-db',
    commit: COMMIT,
    license: 'MIT (see data/voicings/LICENSES/chords-db.txt)',
  },
  voicings,
}
// One voicing per line keeps diffs of the generated file readable.
const { voicings: list, ...header } = file
const headerJson = JSON.stringify(header, null, 2).slice(0, -2)
const body = list.map((v) => `    ${JSON.stringify(v)}`).join(',\n')
await writeFile(OUT, `${headerJson},\n  "voicings": [\n${body}\n  ]\n}\n`)
console.log(`wrote ${voicings.length} voicings to ${OUT.pathname}`)
console.log('skipped:', skipped)
