import {
  LAMBDA_STOPS,
  spellPitchClass,
  toSolfege,
  transform,
  type Mode,
  type ProgressionInput,
} from '@barrefree/theory'
import { useMemo, useState } from 'react'

import {
  CHORD_DISPLAYS,
  choiceName,
  effectiveChoices,
  keyName,
  playsExactly,
  soundingShift,
  symbolKey,
  type ChordDisplay,
  type EffectiveChoice,
  type NameOptions,
} from '../lib/arrangement'
import type { NoteNames } from './useSettings'
import { useVoicingPreferences } from './useVoicingPreferences'

export const DEFAULT_LAMBDA_INDEX = 2 // λ = 10

/** What the user chose on the controls; a song page saves it with the song. */
export interface ArrangementView {
  mode: Mode
  lambdaIndex: number
  noCapo: boolean
  /** The capo the user picked among the alternatives (null: the engine's best). */
  capo: number | null
  shift: number
  display: ChordDisplay
}

export const DEFAULT_VIEW: ArrangementView = {
  mode: 'easy',
  lambdaIndex: DEFAULT_LAMBDA_INDEX,
  noCapo: false,
  capo: null,
  shift: 0,
  display: 'shapes',
}

const MODES: readonly Mode[] = ['original', 'capo', 'easy', 'beginner']
const isInt = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/** A stored view (localStorage, IndexedDB) with every field checked; bad fields are dropped. */
export function sanitizeView(
  stored: Partial<ArrangementView> | undefined,
): Partial<ArrangementView> {
  if (!stored) return {}
  const view: Partial<ArrangementView> = {}
  if (MODES.includes(stored.mode as Mode)) view.mode = stored.mode as Mode
  if (isInt(stored.lambdaIndex, 0, LAMBDA_STOPS.length - 1)) view.lambdaIndex = stored.lambdaIndex
  if (typeof stored.noCapo === 'boolean') view.noCapo = stored.noCapo
  if (stored.capo === null || isInt(stored.capo, 0, 12)) view.capo = stored.capo
  if (isInt(stored.shift, -11, 11)) view.shift = stored.shift
  if (CHORD_DISPLAYS.includes(stored.display as ChordDisplay)) {
    view.display = stored.display as ChordDisplay
  }
  return view
}

export interface ArrangementOptions {
  /** Capo the chords were written for (ChordPro `{capo}`): they sound that much higher. */
  sourceCapo?: number
  noteNames: NoteNames
  initial?: Partial<ArrangementView> | undefined
}

/**
 * The transform engine wired to the arrangement controls (mode, ease/fidelity, capo, transpose,
 * display) and the user's preferred voicings. Shared by the text mode and the song player.
 *
 * `identity` names the chord progression: a capo pick holds only while it stays the same (and
 * for the same mode, no-capo and transpose settings), so editing lyrics keeps it.
 */
export function useArrangement(
  progression: readonly ProgressionInput[],
  identity: string,
  options: ArrangementOptions,
) {
  const { sourceCapo = 0, noteNames } = options
  const initial = sanitizeView(options.initial)
  const [preferences, setPreference] = useVoicingPreferences()
  const [mode, setMode] = useState<Mode>(initial?.mode ?? DEFAULT_VIEW.mode)
  const [lambdaIndex, setLambdaIndex] = useState(initial?.lambdaIndex ?? DEFAULT_VIEW.lambdaIndex)
  const [noCapo, setNoCapo] = useState(initial?.noCapo ?? DEFAULT_VIEW.noCapo)
  const [shift, setShiftState] = useState(initial?.shift ?? DEFAULT_VIEW.shift)
  const [display, setDisplay] = useState<ChordDisplay>(initial?.display ?? DEFAULT_VIEW.display)

  const arrangement = [mode, noCapo, shift, sourceCapo, identity].join('\u0000')
  const [capoPick, setCapoPick] = useState<{ capo: number; for: string } | null>(() =>
    initial?.capo == null ? null : { capo: initial.capo, for: arrangement },
  )
  const capo = capoPick?.for === arrangement ? capoPick.capo : null
  const lambda = LAMBDA_STOPS[lambdaIndex] ?? 10

  const result = useMemo(
    () =>
      transform(progression, {
        mode,
        lambda,
        transpose: shift + sourceCapo,
        ...(noCapo ? { capoRange: [0, 0] as const } : {}),
        ...(capo === null ? {} : { capo }),
      }),
    [progression, mode, lambda, shift, sourceCapo, noCapo, capo],
  )
  const choices = useMemo(
    () => effectiveChoices(result, lambda, preferences),
    [result, lambda, preferences],
  )

  const names: NameOptions = { display, noteNames }
  const choiceOf = (index: number): EffectiveChoice | undefined => {
    const item = result.items[index]
    return item?.input ? choices.get(symbolKey(result, item.input)) : undefined
  }
  /** The name to show for progression item `index`, or null for no-chord / unknown labels. */
  const nameOf = (index: number): string | null => {
    const choice = choiceOf(index)
    return choice ? choiceName(choice, result, names) : null
  }
  const symbolOf = (index: number): string | null => {
    const item = result.items[index]
    return item?.input && choices.has(symbolKey(result, item.input))
      ? symbolKey(result, item.input)
      : null
  }
  const isChanged = (index: number): boolean => {
    const item = result.items[index]
    const choice = choiceOf(index)
    return item?.input && choice ? !playsExactly(item.input, choice, result) : false
  }

  const option = result.option
  const capoOn = option !== null && option.capo > 0
  const shapesShown = display === 'shapes' && capoOn
  const keyLabel = keyName(shapesShown ? result.key.shape : result.key.input, (pc) => {
    const name = spellPitchClass(pc, shapesShown ? result.spelling.shape : result.spelling.input)
    return noteNames === 'solfege' ? toSolfege(name) : name
  })

  /**
   * The pitch frame the chords are shown in, relative to the input: + transpose (and the
   * source's capo), − the capo when shapes are shown. A chord typed by the user in this frame
   * is the input chord moved by `offset`.
   */
  const frame = {
    offset: shift + sourceCapo - (shapesShown ? soundingShift(result) : 0),
    spelling: shapesShown ? result.spelling.shape : result.spelling.input,
  }

  const view: ArrangementView = { mode, lambdaIndex, noCapo, capo, shift, display }
  const controls = {
    mode,
    onMode: setMode,
    lambdaIndex,
    onLambdaIndex: setLambdaIndex,
    alternatives: result.alternatives,
    capo,
    onCapo: (c: number) => setCapoPick({ capo: c, for: arrangement }),
    noCapo,
    onNoCapo: setNoCapo,
    transpose: shift,
    onTranspose: (v: number) => setShiftState(Math.max(-11, Math.min(11, v))),
    display,
    onDisplay: setDisplay,
    keyName: keyLabel,
    infeasible: option === null,
  }

  return {
    result,
    choices,
    names,
    view,
    controls,
    option,
    capoOn,
    shapesShown,
    keyLabel,
    frame,
    nameOf,
    symbolOf,
    isChanged,
    choiceOf,
    pickVoicing: (choice: EffectiveChoice, id: string | null) =>
      setPreference(choice.preferenceKey, id),
  }
}

export type Arrangement = ReturnType<typeof useArrangement>
