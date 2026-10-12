import {
  candidatesFor,
  chordKey,
  formatChordSymbol,
  identifyChord,
  mod12,
  MODE_PRESETS,
  playedNotes,
  realizes,
  simplify,
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
  /** The chord the arrangement plays for (after the mode's simplification), sounding. */
  chord: Chord
  /** The chords as written in the sheet that this choice stands for, sounding. */
  written: Chord[]
  shape: Chord
  /** What the shown voicing plays, in shape space. */
  played: Chord
  voicing: Voicing
  /** Some written chord is not played exactly (a substitute or a simplification). */
  substituted: boolean
  difficulty: number
  fidelity: number
  /** Allowed alternatives for this chord at this capo, cheapest first; includes the shown one. */
  candidates: ScoredCandidate[]
  /** Index of the shown voicing in `candidates` (−1 only if the engine's pick is not allowed). */
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

/** Key of the arrangement symbol a written chord belongs to (see `effectiveChoices`). */
export function symbolKey(result: TransformResult, written: Chord): string {
  return chordKey(simplify(written, MODE_PRESETS[result.mode].simplify))
}

/** Semitones from shape space to sounding pitch: capo plus the tuning's shift. */
function soundingShift(result: TransformResult): number {
  return (result.option?.capo ?? 0) + (uniformShift(result.tuning) ?? 0)
}

/** Whether the choice's voicing plays the written chord exactly (no substitute, no simplification). */
export function playsExactly(
  written: Chord,
  choice: EffectiveChoice,
  result: TransformResult,
): boolean {
  return realizes(transpose(written, -soundingShift(result)), playedNotes(choice.voicing.frets))
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
  const written = new Map<string, Map<string, Chord>>()
  for (const item of result.items) {
    if (!item.input) continue
    const key = symbolKey(result, item.input)
    const group = written.get(key) ?? new Map<string, Chord>()
    group.set(chordKey(item.input), item.input)
    written.set(key, group)
  }
  const config = MODE_PRESETS[result.mode]
  for (const s of option.symbols) {
    const candidates = candidatesFor(s.shape, option.capo, config, { mode: result.mode, lambda })
    const key = preferenceKey(result.mode, s.shape)
    const preferredId = preferences[key]
    const preferred = candidates.find((c) => c.entry.voicing.id === preferredId)
    const symbol = chordKey(s.chord)
    const choice = toEffective(s, candidates, key, preferred)
    choice.written = [...(written.get(symbol)?.values() ?? [s.chord])]
    choice.substituted = choice.written.some((w) => !playsExactly(w, choice, result))
    out.set(symbol, choice)
  }
  return out
}

/** The engine's choice, or the user's allowed pick; `written` and `substituted` are set later. */
function toEffective(
  s: SymbolChoice,
  candidates: ScoredCandidate[],
  key: string,
  preferred: ScoredCandidate | undefined,
): EffectiveChoice {
  const pick = preferred && preferred.entry.voicing.id !== s.voicing.id ? preferred : undefined
  const shownId = pick ? pick.entry.voicing.id : s.voicing.id
  // The shown voicing stays browsable even when it is not among the cheapest alternatives.
  const top = candidates.slice(0, MAX_ALTERNATIVES)
  const shown = candidates.find((c) => c.entry.voicing.id === shownId)
  const list = shown && !top.includes(shown) ? [...top, shown] : top
  const base = {
    chord: s.chord,
    written: [s.chord],
    shape: s.shape,
    substituted: false,
    candidates: list,
    candidateIndex: list.findIndex((c) => c.entry.voicing.id === shownId),
    preferenceKey: key,
  }
  if (!pick) {
    return {
      ...base,
      played: s.played,
      voicing: s.voicing,
      difficulty: s.difficulty,
      fidelity: s.fidelity,
      overridden: false,
    }
  }
  return {
    ...base,
    played: realizes(s.shape, pick.entry.played)
      ? s.shape
      : identifyChord(pick.entry.played.pcs, s.shape.root, pick.entry.played.lowest),
    voicing: pick.entry.voicing,
    difficulty: pick.difficulty,
    fidelity: pick.fidelity,
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
  return formatChordSymbol(transpose(choice.played, soundingShift(result)), {
    spelling: result.spelling.input,
    noteNames: o.noteNames,
  })
}

/** The chords as written in the sheet (sounding, in the song's spelling), e.g. "C, Cadd9". */
export function requestedName(
  choice: EffectiveChoice,
  result: TransformResult,
  o: NameOptions,
): string {
  return choice.written
    .map((w) => formatChordSymbol(w, { spelling: result.spelling.input, noteNames: o.noteNames }))
    .join(', ')
}
