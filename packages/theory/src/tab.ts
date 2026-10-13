/**
 * Tablature: which string and fret plays each transcribed note, and charts to read it.
 *
 * Notes that start together (within `chordWindowSec`) form an event. For every event the
 * candidate states are the ways to put its notes on distinct strings with frets the player can
 * reach (0 = open … `maxFret`, counted from the capo). A Viterbi pass picks one state per event
 * minimizing the cost of the whole piece:
 *
 * - fret height: open strings are free, higher frets cost a little more each;
 * - stretch: fretted notes of one event more than three frets apart are penalized heavily;
 * - hand movement: the distance the fretting hand's position (the mean fretted fret) moves
 *   from one event to the next.
 *
 * Notes no string can play within reach are reported, not forced onto the neck.
 */
import { STANDARD, type Tuning } from './tuning.ts'

export interface NoteIn {
  start: number
  end: number
  midi: number
}

export interface TabNote extends NoteIn {
  /** String index, 0 = the lowest string (6th), as in fret arrays. */
  string: number
  /** Fret counted from the capo (0 = open or capo). */
  fret: number
}

export interface TabOptions {
  tuning?: Tuning
  capo?: number
  /** Highest fret above the capo; 5 keeps the hand in open position (no barre needed). */
  maxFret?: number
  /** Notes starting within this many seconds of each other are played together. */
  chordWindowSec?: number
}

export interface TabResult {
  notes: TabNote[]
  /** Notes out of reach of every string (too low, or too high for `maxFret`). */
  unplayable: NoteIn[]
}

const COST = { fret: 0.3, fretted: 0.5, stretch: 6, move: 1 } as const
/** Candidate states per event are capped; more only appear with large chords. */
const MAX_STATES = 400

type State = { strings: number[]; frets: number[]; cost: number; position: number | null }

function candidates(pitches: readonly number[], open: readonly number[], maxFret: number): State[] {
  const states: State[] = []
  const strings: number[] = []
  const frets: number[] = []
  const used = new Set<number>()
  const visit = (i: number) => {
    if (states.length >= MAX_STATES) return
    if (i === pitches.length) {
      const fretted = frets.filter((f) => f > 0)
      const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0
      const cost =
        frets.reduce((sum, f) => sum + (f > 0 ? COST.fretted + COST.fret * f : 0), 0) +
        (span > 3 ? COST.stretch * (span - 3) : 0)
      const position = fretted.length ? fretted.reduce((a, b) => a + b, 0) / fretted.length : null
      states.push({ strings: [...strings], frets: [...frets], cost, position })
      return
    }
    const pitch = pitches[i] ?? 0
    open.forEach((base, s) => {
      const fret = pitch - base
      if (used.has(s) || fret < 0 || fret > maxFret) return
      used.add(s)
      strings.push(s)
      frets.push(fret)
      visit(i + 1)
      used.delete(s)
      strings.pop()
      frets.pop()
    })
  }
  visit(0)
  return states
}

/**
 * The most notes of an event that fit on distinct strings within reach. Inner voices are
 * dropped first: the bass and the melody (lowest and highest) matter most in a tab.
 */
function largestPlayable(
  notes: readonly NoteIn[],
  open: readonly number[],
  maxFret: number,
): [NoteIn[], State[]] {
  // Never more notes than strings; beyond that, keep the outer voices.
  const pool = [...notes]
  while (pool.length > open.length) pool.splice(Math.floor(pool.length / 2), 1)
  for (let size = pool.length; size > 0; size--) {
    for (const keep of subsets(pool.length, size)) {
      const chord = keep.map((i) => pool[i]).filter((n): n is NoteIn => n !== undefined)
      const states = candidates(
        chord.map((n) => n.midi),
        open,
        maxFret,
      )
      if (states.length > 0) return [chord, states]
    }
  }
  return [[], []]
}

/** Index subsets of a given size, those keeping the outer indices first. */
function subsets(n: number, size: number): number[][] {
  const all: number[][] = []
  const pick = (from: number, chosen: number[]) => {
    if (chosen.length === size) {
      all.push([...chosen])
      return
    }
    for (let i = from; i < n; i++) pick(i + 1, [...chosen, i])
  }
  pick(0, [])
  // Dropped indices nearest the middle first.
  const inner = (keep: number[]) =>
    -Array.from({ length: n }, (_, i) => i)
      .filter((i) => !keep.includes(i))
      .reduce((sum, i) => sum + Math.abs(i - (n - 1) / 2), 0)
  return all.sort((a, b) => inner(b) - inner(a))
}

/** Groups notes that start together; each group is sorted low to high. */
function events(notes: readonly NoteIn[], window: number): NoteIn[][] {
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi)
  const groups: NoteIn[][] = []
  for (const note of sorted) {
    const last = groups.at(-1)
    const first = last?.[0]
    if (last && first && note.start - first.start <= window) last.push(note)
    else groups.push([note])
  }
  return groups.map((g) => g.sort((a, b) => a.midi - b.midi))
}

export function assignTab(notes: readonly NoteIn[], options: TabOptions = {}): TabResult {
  const { tuning = STANDARD, capo = 0, maxFret = 5, chordWindowSec = 0.035 } = options
  const open = tuning.midi.map((m) => m + capo)
  const unplayable: NoteIn[] = []
  const steps: { notes: NoteIn[]; states: State[] }[] = []

  for (const group of events(notes, chordWindowSec)) {
    // A note no string can reach is set aside; so is one more note than there are strings.
    const playable = group.filter((n) => open.some((b) => n.midi - b >= 0 && n.midi - b <= maxFret))
    unplayable.push(...group.filter((n) => !playable.includes(n)))
    const [chord, states] = largestPlayable(playable, open, maxFret)
    unplayable.push(...playable.filter((n) => !chord.includes(n)))
    if (states.length > 0) steps.push({ notes: chord, states })
  }

  // Viterbi over the events.
  const best: { cost: number; from: number; position: number | null }[][] = []
  steps.forEach((step, t) => {
    const row = step.states.map((state) => {
      if (t === 0) return { cost: state.cost, from: -1, position: state.position }
      let cost = Infinity
      let from = -1
      let position: number | null = state.position
      ;(best[t - 1] ?? []).forEach((prev, k) => {
        const here = state.position ?? prev.position
        const there = prev.position ?? here
        const move = here !== null && there !== null ? Math.abs(here - there) : 0
        const total = prev.cost + state.cost + COST.move * move
        if (total < cost) {
          cost = total
          from = k
          position = here
        }
      })
      return { cost, from, position }
    })
    best.push(row)
  })

  const chosen: number[] = []
  let k = (best.at(-1) ?? []).reduce(
    (b, cell, i, all) => (cell.cost < (all[b]?.cost ?? Infinity) ? i : b),
    0,
  )
  for (let t = steps.length - 1; t >= 0; t--) {
    chosen[t] = k
    k = best[t]?.[k]?.from ?? 0
  }

  const out: TabNote[] = []
  steps.forEach((step, t) => {
    const state = step.states[chosen[t] ?? 0]
    if (!state) return
    step.notes.forEach((note, i) =>
      out.push({ ...note, string: state.strings[i] ?? 0, fret: state.frets[i] ?? 0 }),
    )
  })
  return { notes: out, unplayable }
}

export interface TabGrid {
  /** Seconds per grid step (a sixteenth note at the given tempo). */
  step: number
  /** Time of the first grid step (a downbeat). */
  origin: number
  stepsPerBar: number
}

/**
 * A sixteenth-note grid from the tempo and the first downbeat. It starts on the bar line of the
 * bar holding the first note (`firstNote`, default the downbeat): a pickup before the downbeat
 * gets its own bar, and silence before the first note gets none.
 */
export function tabGrid(
  bpm: number,
  firstDownbeat = 0,
  beatsPerBar = 4,
  firstNote = firstDownbeat,
): TabGrid {
  const step = 60 / bpm / 4
  const bar = step * 4 * beatsPerBar
  // Whole bars between the downbeat and the first note (negative: before it), rounded so that
  // a note a hair before a bar line still belongs to it.
  const bars = Math.floor((firstNote - firstDownbeat + step / 2) / bar)
  return { step, origin: firstDownbeat + bars * bar, stepsPerBar: 4 * beatsPerBar }
}

const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'] as const

/**
 * Plain-text tab, high e string on top, one column per sixteenth, `barsPerLine` bars a line:
 *
 *     e|-----0-------0--|
 *     B|---1---1---1----|
 */
export function tabToText(notes: readonly TabNote[], grid: TabGrid, barsPerLine = 4): string {
  if (notes.length === 0) return ''
  const slot = (time: number) => Math.max(0, Math.round((time - grid.origin) / grid.step))
  const lastSlot = Math.max(...notes.map((n) => slot(n.start)))
  const bars = Math.floor(lastSlot / grid.stepsPerBar) + 1
  // Two characters per slot so that two-digit frets keep the columns aligned.
  const rows = STRING_NAMES.map(() => Array.from({ length: bars * grid.stepsPerBar }, () => '--'))
  for (const n of notes) {
    const row = rows[n.string]
    if (row) row[slot(n.start)] = String(n.fret).padEnd(2, '-')
  }
  const lines: string[] = []
  for (let b = 0; b < bars; b += barsPerLine) {
    const from = b * grid.stepsPerBar
    const to = Math.min(bars, b + barsPerLine) * grid.stepsPerBar
    for (let s = 5; s >= 0; s--) {
      const cells = rows[s]?.slice(from, to) ?? []
      const barsText: string[] = []
      for (let i = 0; i < cells.length; i += grid.stepsPerBar) {
        barsText.push(cells.slice(i, i + grid.stepsPerBar).join(''))
      }
      lines.push(`${STRING_NAMES[s] ?? '?'}|${barsText.join('|')}|`)
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/** Standard note values in sixteenths, longest first, with their MusicXML names. */
const VALUES: readonly (readonly [number, string, boolean])[] = [
  [16, 'whole', false],
  [12, 'half', true],
  [8, 'half', false],
  [6, 'quarter', true],
  [4, 'quarter', false],
  [3, 'eighth', true],
  [2, 'eighth', false],
  [1, '16th', false],
]
const SHARP_STEPS = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'] as const

/** Splits a length in sixteenths into standard values (tied in the score). */
function noteValues(length: number): (readonly [number, string, boolean])[] {
  const parts: (readonly [number, string, boolean])[] = []
  let left = length
  while (left > 0) {
    const value = VALUES.find(([n]) => n <= left) ?? VALUES[VALUES.length - 1]
    if (!value) break
    parts.push(value)
    left -= value[0]
  }
  return parts
}

function pitchXml(midi: number): string {
  const pc = ((midi % 12) + 12) % 12
  const alter = [1, 3, 6, 8, 10].includes(pc) ? '<alter>1</alter>' : ''
  return `<pitch><step>${SHARP_STEPS[pc] ?? 'C'}</step>${alter}<octave>${Math.floor(midi / 12) - 1}</octave></pitch>`
}

const escapeXml = (text: string) => text.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

export interface MusicXmlOptions {
  title?: string
  tuning?: Tuning
  capo?: number
  beatsPerBar?: number
}

/**
 * MusicXML (4.0, partwise) with a six-line tablature staff: string and fret for every note,
 * onsets quantized to the sixteenth grid, each note held until the next onset (a tab shows when
 * to pick, not how long to let it ring), split into tied standard values at bar lines.
 */
export function tabToMusicXml(
  notes: readonly TabNote[],
  grid: TabGrid,
  options: MusicXmlOptions = {},
): string {
  const { title = 'BarreFree', tuning = STANDARD, capo = 0, beatsPerBar = 4 } = options
  const slot = (time: number) => Math.max(0, Math.round((time - grid.origin) / grid.step))
  const bySlot = new Map<number, TabNote[]>()
  for (const n of notes) {
    const at = slot(n.start)
    const here = bySlot.get(at) ?? []
    // One note per string per onset.
    if (!here.some((m) => m.string === n.string)) here.push(n)
    bySlot.set(at, here)
  }
  const onsets = [...bySlot.keys()].sort((a, b) => a - b)
  const perBar = grid.stepsPerBar
  const lastOnset = onsets.at(-1) ?? 0
  const bars = Math.floor(lastOnset / perBar) + 1
  const total = bars * perBar

  const noteXml = (n: TabNote, i: number, len: number, type: string, dot: boolean, tie: string[]) =>
    `<note>${i > 0 ? '<chord/>' : ''}${pitchXml(n.midi)}<duration>${len}</duration>` +
    tie.map((t) => `<tie type="${t}"/>`).join('') +
    `<voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}<notations>` +
    tie.map((t) => `<tied type="${t}"/>`).join('') +
    `<technical><string>${6 - n.string}</string><fret>${n.fret}</fret></technical></notations></note>`
  const restXml = (len: number) =>
    noteValues(len)
      .map(
        ([n, type, dot]) =>
          `<note><rest/><duration>${n}</duration><voice>1</voice><type>${type}</type>${dot ? '<dot/>' : ''}</note>`,
      )
      .join('')

  const measures: string[] = []
  for (let bar = 0; bar < bars; bar++) {
    const from = bar * perBar
    const to = from + perBar
    let body = ''
    let cursor = from
    // A chord held over the bar line from the previous bar continues tied.
    const carried = onsets.filter((o) => o < from).at(-1)
    const next = (o: number) => onsets.find((x) => x > o) ?? total
    if (carried !== undefined && next(carried) > from) {
      const chord = bySlot.get(carried) ?? []
      const end = Math.min(next(carried), to)
      const parts = noteValues(end - from)
      parts.forEach(([len, type, dot], p) => {
        const tie = ['stop', ...(p < parts.length - 1 || next(carried) > to ? ['start'] : [])]
        body += chord.map((n, i) => noteXml(n, i, len, type, dot, tie)).join('')
      })
      cursor = end
    }
    for (const onset of onsets.filter((o) => o >= from && o < to)) {
      if (onset > cursor) body += restXml(onset - cursor)
      const chord = bySlot.get(onset) ?? []
      const end = Math.min(next(onset), to)
      const parts = noteValues(end - onset)
      parts.forEach(([len, type, dot], p) => {
        const tie = [
          ...(p > 0 ? ['stop'] : []),
          ...(p < parts.length - 1 || next(onset) > to ? ['start'] : []),
        ]
        body += chord.map((n, i) => noteXml(n, i, len, type, dot, tie)).join('')
      })
      cursor = end
    }
    if (cursor < to) body += restXml(to - cursor)
    const attributes =
      bar === 0
        ? '<attributes><divisions>4</divisions><key><fifths>0</fifths></key>' +
          `<time><beats>${beatsPerBar}</beats><beat-type>4</beat-type></time>` +
          '<clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>6</staff-lines>' +
          tuning.midi
            .map((m, i) => {
              const pc = ((m % 12) + 12) % 12
              const alter = [1, 3, 6, 8, 10].includes(pc) ? '<tuning-alter>1</tuning-alter>' : ''
              return `<staff-tuning line="${i + 1}"><tuning-step>${SHARP_STEPS[pc] ?? 'E'}</tuning-step>${alter}<tuning-octave>${Math.floor(m / 12) - 1}</tuning-octave></staff-tuning>`
            })
            .join('') +
          (capo > 0 ? `<capo>${capo}</capo>` : '') +
          '</staff-details></attributes>'
        : ''
    measures.push(`<measure number="${bar + 1}">${attributes}${body}</measure>`)
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">',
    '<score-partwise version="4.0">',
    `<work><work-title>${escapeXml(title)}</work-title></work>`,
    '<part-list><score-part id="P1"><part-name>Guitar</part-name></score-part></part-list>',
    `<part id="P1">${measures.join('')}</part>`,
    '</score-partwise>',
    '',
  ].join('\n')
}
