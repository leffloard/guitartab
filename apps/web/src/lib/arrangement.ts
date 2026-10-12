import {
  candidatesFor,
  chordKey,
  formatChordSymbol,
  identifyChord,
  mod12,
  MODE_PRESETS,
  realizes,
  transpose,
  uniformShift,
  type Chord,
  type KeySignature,
  type Mode,
  type PitchClass,
  type ScoredCandidate,
  type SymbolChoice,
  type TransformResult,
  type Voicing,
} from '@barrefree/theory'

/** What the sheet shows for a chord: the shape to fret, or what it sounds like. */
export const CHORD_DISPLAYS = ['shapes', 'sounding'] as const
export type ChordDisplay = (typeof CHORD_DISPLAYS)[number]

export interface EffectiveChoice {
  /** The chord as requested (sounding). */
  chord: Chord
  shape: Chord
  /** What the shown voicing plays, in shape space. */
  played: Chord
  voicing: Voicing
  substituted: boolean
  difficulty: number
  fidelity: number
  /** Allowed alternatives for this chord at this capo, cheapest first. */
  candidates: ScoredCandidate[]
  /** Index of the shown voicing in `candidates` (−1 if it is not among them). */
  candidateIndex: number
  /** Key under which the user's preferred voicing is stored. */
  preferenceKey: string
  /** The shown voicing is the user's pick, not the engine's. */
  overridden: boolean
}

export const MAX_ALTERNATIVES = 8

export const MODES: readonly Mode[] = ['original', 'capo', 'easy', 'beginner']

/** "C / Am" style name of a key signature's major and relative minor. */
export function keyName(key: KeySignature, spell: (pc: PitchClass) => string): string {
  return `${spell(key.tonic)} / ${spell(mod12(key.tonic + 9))}m`
}

export function preferenceKey(mode: Mode, shape: Chord): string {
  return `${mode}|${chordKey(shape)}`
}

/**
 * Applies the user's preferred voicings on top of the engine's choices. A preference is only
 * used when that shape is an allowed candidate for the chord in the current mode and capo.
 */
export function effectiveChoices(
  result: TransformResult,
  lambda: number,
  preferences: Readonly<Record<string, string>>,
): Map<string, EffectiveChoice> {
  const out = new Map<string, EffectiveChoice>()
  const option = result.option
  if (!option) return out
  const config = MODE_PRESETS[result.mode]
  for (const s of option.symbols) {
    const candidates = candidatesFor(s.shape, option.capo, config, { mode: result.mode, lambda })
    const key = preferenceKey(result.mode, s.shape)
    const preferredId = preferences[key]
    const preferred = candidates.find((c) => c.entry.voicing.id === preferredId)
    out.set(chordKey(s.chord), toEffective(s, candidates, key, preferred))
  }
  return out
}

function toEffective(
  s: SymbolChoice,
  candidates: ScoredCandidate[],
  key: string,
  preferred: ScoredCandidate | undefined,
): EffectiveChoice {
  const top = candidates.slice(0, MAX_ALTERNATIVES)
  if (!preferred || preferred.entry.voicing.id === s.voicing.id) {
    return {
      chord: s.chord,
      shape: s.shape,
      played: s.played,
      voicing: s.voicing,
      substituted: s.substituted,
      difficulty: s.difficulty,
      fidelity: s.fidelity,
      candidates: top,
      candidateIndex: top.findIndex((c) => c.entry.voicing.id === s.voicing.id),
      preferenceKey: key,
      overridden: false,
    }
  }
  const exact = realizes(s.shape, preferred.entry.played)
  return {
    chord: s.chord,
    shape: s.shape,
    played: exact
      ? s.shape
      : identifyChord(preferred.entry.played.pcs, s.shape.root, preferred.entry.played.lowest),
    voicing: preferred.entry.voicing,
    substituted: !exact,
    difficulty: preferred.difficulty,
    fidelity: preferred.fidelity,
    candidates: top,
    candidateIndex: top.findIndex((c) => c.entry.voicing.id === preferred.entry.voicing.id),
    preferenceKey: key,
    overridden: true,
  }
}

export interface NameOptions {
  display: ChordDisplay
  noteNames: 'letter' | 'solfege'
}

/** The name shown for a choice: the shape to fret (capo on), or the sound you hear. */
export function choiceName(
  choice: EffectiveChoice,
  result: TransformResult,
  o: NameOptions,
): string {
  if (o.display === 'shapes') {
    return formatChordSymbol(choice.played, {
      spelling: result.spelling.shape,
      noteNames: o.noteNames,
    })
  }
  const shift = (result.option?.capo ?? 0) + (uniformShift(result.tuning) ?? 0)
  return formatChordSymbol(transpose(choice.played, shift), {
    spelling: result.spelling.input,
    noteNames: o.noteNames,
  })
}

/** The requested chord's name (what the sheet asked for), in the song's spelling. */
export function requestedName(
  choice: EffectiveChoice,
  result: TransformResult,
  o: NameOptions,
): string {
  return formatChordSymbol(choice.chord, {
    spelling: result.spelling.input,
    noteNames: o.noteNames,
  })
}
