/**
 * The transform engine: capo search and voicing selection for the four difficulty modes.
 */
import { solveAssignment, type AssignmentProblem } from './assign.ts'
import {
  chordKey,
  describe,
  identifyChord,
  simplify,
  transpose,
  type Chord,
  type SimplifyLevel,
} from './chord.ts'
import { estimateKeySignature, spellingForKey, type KeySignature } from './key.ts'
import {
  generateVoicings,
  getDefaultLibrary,
  type LibraryEntry,
  type VoicingLibrary,
} from './library.ts'
import { mod12, type Spelling } from './pitch.ts'
import {
  parseChordLabel,
  symbolWeights,
  type ParsedLabel,
  type ProgressionInput,
} from './progression.ts'
import {
  DEFAULT_DIFFICULTY,
  DEFAULT_FIDELITY,
  difficulty,
  fidelityOf,
  prepareTarget,
  realizes,
  realizesPrepared,
  type DifficultyWeights,
  type FidelityWeights,
} from './score.ts'
import { STANDARD, uniformShift, type Tuning } from './tuning.ts'
import type { Voicing } from './voicing.ts'

export type Mode = 'original' | 'capo' | 'easy' | 'beginner'

export interface ModeConfig {
  capoRange: readonly [number, number]
  /** `realizes`: play the chord as written. `floor`: substitutes allowed above `fidelityFloor`. */
  constraint: 'realizes' | 'floor'
  fidelityFloor: number
  minStrings: number
  /** Drop full-barre shapes whenever any other shape is allowed. */
  forbidFullBarre: boolean
  simplify: SimplifyLevel
  /**
   * Cost of each distinct shape, divided by the number of distinct chords (encourages reusing
   * shapes): with equal weights, a chord accepts a substitute up to μ worse to share a shape.
   */
  mu: number
}

export const MODE_PRESETS: Readonly<Record<Mode, ModeConfig>> = {
  original: {
    capoRange: [0, 0],
    constraint: 'realizes',
    fidelityFloor: 0,
    minStrings: 3,
    forbidFullBarre: false,
    simplify: 'none',
    mu: 0,
  },
  capo: {
    capoRange: [0, 7],
    constraint: 'realizes',
    fidelityFloor: 0,
    minStrings: 3,
    forbidFullBarre: false,
    simplify: 'none',
    mu: 0.1,
  },
  easy: {
    capoRange: [0, 7],
    constraint: 'floor',
    fidelityFloor: 0.75,
    minStrings: 4,
    forbidFullBarre: true,
    simplify: 'none',
    mu: 0.1,
  },
  beginner: {
    capoRange: [0, 7],
    constraint: 'floor',
    fidelityFloor: 0.7,
    minStrings: 3,
    forbidFullBarre: true,
    simplify: 'drop-tensions',
    mu: 0.5,
  },
}

/** The "fidelity ↔ ease" slider has fixed stops: low λ favors easy shapes, high λ fidelity. */
export const LAMBDA_STOPS = [2, 5, 10, 20, 40] as const
export const DEFAULT_LAMBDA = 10

/** Highest physical fret (capo + fret) a chosen shape may reach. */
const MAX_PHYSICAL_FRET = 15
/** Totals closer than this are a tie, which the lower capo wins. */
const TIE_EPSILON = 0.05

export interface TransformOptions {
  mode: Mode
  /** Weight of fidelity loss against difficulty (see {@link LAMBDA_STOPS}). */
  lambda?: number
  tuning?: Tuning
  /** Overrides the mode's capo range, e.g. [0, 0] for "no capo". */
  capoRange?: readonly [number, number]
  /** Use this capo (if feasible) instead of the best one, e.g. when the user picks an alternative. */
  capo?: number
  /** Transpose the song by this many semitones before anything else (key change). */
  transpose?: number
  library?: VoicingLibrary
  difficultyWeights?: DifficultyWeights
  fidelityWeights?: FidelityWeights
  minSegmentSec?: number
}

/** Capo penalty: a little per fret, more above the 4th (a high capo thins the sound). */
export function capoPenalty(capo: number): number {
  return 0.1 * capo + 0.2 * Math.max(0, capo - 4) ** 2
}

export interface ScoredCandidate {
  entry: LibraryEntry
  difficulty: number
  fidelity: number
  cost: number
}

export interface SymbolChoice {
  /** The chord as requested (after mode simplification), sounding pitch. */
  chord: Chord
  weight: number
  /** The chord to fret with the capo on (shape space). */
  shape: Chord
  /** What the chosen shape actually plays, in shape space (e.g. Fmaj7 for an F). */
  played: Chord
  voicing: Voicing
  difficulty: number
  fidelity: number
  cost: number
  /** The shape does not play the chord exactly as written. */
  substituted: boolean
}

export interface CapoOption {
  capo: number
  /** Objective value: Σ weight·cost + (μ / chords)·shapes + capo penalty (lower is better). */
  total: number
  meanDifficulty: number
  meanFidelity: number
  fullBarres: number
  miniBarres: number
  distinctShapes: number
  symbols: SymbolChoice[]
}

export interface TransformItem {
  index: number
  label: string
  start?: number
  end?: number
  /** Parsed input (null for no-chord or unparsable labels). */
  input: Chord | null
  invalid?: string
  choice: SymbolChoice | null
}

export interface TransformResult {
  mode: Mode
  lambda: number
  tuning: Tuning
  /** Chosen option (null if no capo position can play every chord). */
  option: CapoOption | null
  /** Best options, chosen first, at most three. */
  alternatives: CapoOption[]
  infeasibleCapos: number[]
  items: TransformItem[]
  /** Spelling for sounding chord names and for shape names. */
  spelling: { input: Spelling; shape: Spelling }
  /** Estimated key signature of the song as heard and of the shapes as fingered. */
  key: { input: KeySignature; shape: KeySignature }
}

type ResolvedOptions = TransformOptions & { lambda: number }

interface Evaluated {
  entry: LibraryEntry
  difficulty: number
  fidelity: number
}

/**
 * λ-independent evaluations, memoized per library. Switching the λ slider or the mode then only
 * re-sorts short lists instead of rescoring the whole library. The cache is invisible to callers
 * (results depend only on the key) and is skipped for custom weights.
 */
const evaluationCache = new WeakMap<VoicingLibrary, Map<string, readonly Evaluated[]>>()
const CACHE_LIMIT = 5000

const THIRD_INTERVAL = { M3: 4, m3: 3, sus2: 2, sus4: 5 } as const

function evaluateShapes(
  target: Chord,
  capo: number,
  config: ModeConfig,
  options: TransformOptions,
  library: VoicingLibrary,
): readonly Evaluated[] {
  const dw = options.difficultyWeights ?? DEFAULT_DIFFICULTY
  const fw = options.fidelityWeights ?? DEFAULT_FIDELITY
  const cacheable = dw === DEFAULT_DIFFICULTY && fw === DEFAULT_FIDELITY
  const key = `${chordKey(target)}|${capo}|${config.constraint}|${config.fidelityFloor}|${config.minStrings}|${config.forbidFullBarre}`
  let cache = evaluationCache.get(library)
  const hit = cacheable ? cache?.get(key) : undefined
  if (hit) return hit

  const prepared = prepareTarget(target, fw)
  const { third } = describe(target)
  // Floor for substitutes: the root sounds, and so does the third (or sus tone) if there is one.
  const rootAndThird = 1 | (third === null ? 0 : 1 << THIRD_INTERVAL[third])
  const evaluate = (entries: readonly LibraryEntry[]): Evaluated[] => {
    const out: Evaluated[] = []
    for (const entry of entries) {
      if (capo + entry.info.maxFret > MAX_PHYSICAL_FRET) continue
      if (entry.info.sounding < config.minStrings) continue
      const fid = fidelityOf(prepared, entry.played)
      if (config.constraint === 'realizes') {
        if (!realizesPrepared(prepared, entry.played)) continue
      } else {
        if (fid.clash || fid.value < config.fidelityFloor - 1e-9) continue
        let played = 0
        for (const pc of entry.played.pcs) played |= 1 << mod12(pc - target.root)
        if ((played & rootAndThird) !== rootAndThird) continue
      }
      out.push({ entry, difficulty: difficulty(entry.info, dw).total, fidelity: fid.value })
    }
    return out
  }

  let list = evaluate(library.byPitchClass[target.root] ?? [])
  if (list.length === 0) {
    // Filter the generator's full output: its easiest shapes may all fail the mode's test.
    list = evaluate(
      generateVoicings(target, {
        minStrings: Math.max(config.minStrings, 3),
        maxFret: MAX_PHYSICAL_FRET - capo,
        limit: Number.POSITIVE_INFINITY,
      }),
    )
  }
  if (config.forbidFullBarre && list.some((c) => !c.entry.info.barres.some((b) => b.full))) {
    list = list.filter((c) => !c.entry.info.barres.some((b) => b.full))
  }
  if (cacheable) {
    if (!cache) {
      cache = new Map()
      evaluationCache.set(library, cache)
    }
    if (cache.size >= CACHE_LIMIT) cache.clear()
    cache.set(key, list)
  }
  return list
}

/**
 * Allowed voicings for one chord at one capo position (target in shape space), cheapest first.
 * Falls back to the fretboard generator when the library has nothing allowed.
 */
export function candidatesFor(
  target: Chord,
  capo: number,
  config: ModeConfig,
  options: ResolvedOptions,
  library: VoicingLibrary = getDefaultLibrary(),
): ScoredCandidate[] {
  return evaluateShapes(target, capo, config, options, library)
    .map((e) => ({ ...e, cost: e.difficulty + options.lambda * (1 - e.fidelity) }))
    .sort(
      (a, b) =>
        a.cost - b.cost ||
        a.difficulty - b.difficulty ||
        (a.entry.voicing.id < b.entry.voicing.id
          ? -1
          : a.entry.voicing.id > b.entry.voicing.id
            ? 1
            : 0),
    )
}

function solveCapo(
  symbols: readonly { chord: Chord; weight: number }[],
  capo: number,
  shift: number,
  config: ModeConfig,
  options: ResolvedOptions,
  library: VoicingLibrary,
): CapoOption | null {
  const lists = symbols.map((s) =>
    candidatesFor(transpose(s.chord, -(capo + shift)), capo, config, options, library),
  )
  if (lists.some((l) => l.length === 0)) return null
  const problem: AssignmentProblem = {
    weights: symbols.map((s) => s.weight),
    candidates: lists.map((l) => l.map((c) => ({ id: c.entry.voicing.id, cost: c.cost }))),
    // Per-shape cost normalized by the number of symbols: with equal weights a chord then accepts
    // a substitute at most μ worse to reuse a shape, however long the song is.
    mu: config.mu / Math.max(1, symbols.length),
  }
  const solution = solveAssignment(problem)
  const chosen: SymbolChoice[] = symbols.map((s, i) => {
    const cand = lists[i]?.[solution.choice[i] ?? 0]
    if (!cand) throw new Error('assignment returned an invalid candidate')
    const shape = transpose(s.chord, -(capo + shift))
    const exact = realizes(shape, cand.entry.played)
    // An exact voicing is shown under the chord's own name (a C7 shape without its G is still
    // "C7"); a substitute is named from the notes it plays.
    const played = exact
      ? shape
      : identifyChord(cand.entry.played.pcs, shape.root, cand.entry.played.lowest)
    return {
      chord: s.chord,
      weight: s.weight,
      shape,
      played,
      voicing: cand.entry.voicing,
      difficulty: cand.difficulty,
      fidelity: cand.fidelity,
      cost: cand.cost,
      substituted: !exact,
    }
  })
  let meanDifficulty = 0
  let meanFidelity = 0
  let fullBarres = 0
  let miniBarres = 0
  chosen.forEach((c, i) => {
    meanDifficulty += c.weight * c.difficulty
    meanFidelity += c.weight * c.fidelity
    const barres = lists[i]?.[solution.choice[i] ?? 0]?.entry.info.barres ?? []
    fullBarres += barres.filter((b) => b.full).length
    miniBarres += barres.filter((b) => !b.full).length
  })
  return {
    capo,
    total: solution.total + capoPenalty(capo),
    meanDifficulty,
    meanFidelity,
    fullBarres,
    miniBarres,
    distinctShapes: new Set(chosen.map((c) => c.voicing.id)).size,
    symbols: chosen,
  }
}

/** Transforms a progression for the given mode. Pure and deterministic. */
export function transform(
  progression: readonly ProgressionInput[],
  options: TransformOptions,
): TransformResult {
  const config = MODE_PRESETS[options.mode]
  const lambda = options.lambda ?? DEFAULT_LAMBDA
  const tuning = options.tuning ?? STANDARD
  const shift = uniformShift(tuning)
  if (shift === null)
    throw new Error(`tuning ${tuning.id} is not a uniform shift of standard tuning`)
  const library = options.library ?? getDefaultLibrary()
  const opts = { ...options, lambda }

  const shiftBy = options.transpose ?? 0
  const parsed: ParsedLabel[] = progression.map((p) => {
    const label = parseChordLabel(p.label)
    return label.kind === 'chord' && shiftBy !== 0
      ? { kind: 'chord', chord: transpose(label.chord, shiftBy) }
      : label
  })
  const timedChords = progression.flatMap((p, i) => {
    const label = parsed[i]
    return label?.kind === 'chord'
      ? [{ chord: simplify(label.chord, config.simplify), start: p.start, end: p.end }]
      : []
  })
  const symbols = symbolWeights(timedChords, { minSegmentSec: options.minSegmentSec ?? 0.25 })

  const [lo, hi] = options.capoRange ?? config.capoRange
  const feasible: CapoOption[] = []
  const infeasibleCapos: number[] = []
  for (let capo = lo; capo <= hi; capo++) {
    const option = solveCapo(symbols, capo, shift, config, opts, library)
    if (option) feasible.push(option)
    else infeasibleCapos.push(capo)
  }
  const ranked = [...feasible].sort((a, b) => a.total - b.total || a.capo - b.capo)
  const bestTotal = ranked[0]?.total ?? Infinity
  // Near-ties go to the lowest capo; an explicitly requested capo wins if it is feasible.
  const chosen =
    feasible.find((o) => o.capo === options.capo) ??
    [...feasible].sort((a, b) => a.capo - b.capo).find((o) => o.total <= bestTotal + TIE_EPSILON) ??
    null
  const alternatives = chosen ? [chosen, ...ranked.filter((o) => o !== chosen)].slice(0, 3) : []

  const byKey = new Map((chosen?.symbols ?? []).map((s) => [chordKey(s.chord), s]))
  const items: TransformItem[] = progression.map((p, index) => {
    const label = parsed[index]
    const base = {
      index,
      label: p.label,
      ...(p.start === undefined ? {} : { start: p.start }),
      ...(p.end === undefined ? {} : { end: p.end }),
    }
    if (label?.kind !== 'chord') {
      return {
        ...base,
        input: null,
        choice: null,
        ...(label?.kind === 'invalid' ? { invalid: label.error } : {}),
      }
    }
    return {
      ...base,
      input: label.chord,
      choice: byKey.get(chordKey(simplify(label.chord, config.simplify))) ?? null,
    }
  })

  const sharps = progression.filter((p) => /^\s*[A-G][#♯]/.test(p.label)).length
  const flats = progression.filter((p) => /^\s*[A-G][b♭]/.test(p.label)).length
  // The user's accidentals only tell us about the key they wrote, not a transposed one.
  const hint = shiftBy !== 0 ? null : flats > sharps ? 'flat' : sharps > flats ? 'sharp' : null
  const inputKey = estimateKeySignature(symbols, hint)
  const shapeKey = estimateKeySignature(
    (chosen?.symbols ?? []).map((s) => ({ chord: s.shape, weight: s.weight })),
  )
  return {
    mode: options.mode,
    lambda,
    tuning,
    option: chosen,
    alternatives,
    infeasibleCapos,
    items,
    spelling: { input: spellingForKey(inputKey), shape: spellingForKey(shapeKey) },
    key: { input: inputKey, shape: shapeKey },
  }
}
