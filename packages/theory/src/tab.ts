/**
 * Tablature: which string and fret plays each transcribed note, and charts to read it.
 *
 * Notes that start together (within `chordWindowSec`) form an event. For every event the
 * candidate states are the ways to put its notes on distinct strings with frets the player can
 * reach (0 = open … `maxFret`, counted from the capo). A Viterbi pass picks one state per event
 * minimizing the cost of the whole piece (`tabCost`):
 *
 * - fret height: open strings are free, higher frets cost a little more each;
 * - stretch: fretted notes of one event more than three frets apart are penalized heavily;
 * - hand movement: the distance the fretting hand's position (the mean fretted fret) moves
 *   from one fretted event to the next; open strings leave the hand where it was.
 *
 * Because open strings carry the hand position over, the pass keeps one cell per state and
 * carried position, so the result is the exact optimum of that cost. Notes no string can play
 * within reach are reported, not forced onto the neck.
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
/** Larger groups of simultaneous notes lose inner voices before the subset search. */
const MAX_GROUP = 10

type State = { strings: number[]; frets: number[]; cost: number; position: number | null }

/** The cost of one event's frets on their own: height and stretch. */
function shapeCost(frets: readonly number[]): { cost: number; position: number | null } {
  const fretted = frets.filter((f) => f > 0)
  const span = fretted.length ? Math.max(...fretted) - Math.min(...fretted) : 0
  const cost =
    frets.reduce((sum, f) => sum + (f > 0 ? COST.fretted + COST.fret * f : 0), 0) +
    (span > 3 ? COST.stretch * (span - 3) : 0)
  const position = fretted.length ? fretted.reduce((a, b) => a + b, 0) / fretted.length : null
  return { cost, position }
}

function candidates(pitches: readonly number[], open: readonly number[], maxFret: number): State[] {
  const states: State[] = []
  const strings: number[] = []
  const frets: number[] = []
  const used = new Set<number>()
  const visit = (i: number) => {
    if (states.length >= MAX_STATES) return
    if (i === pitches.length) {
      states.push({ strings: [...strings], frets: [...frets], ...shapeCost(frets) })
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
  // Every subset is searched, largest first (a group never has more notes than strings);
  // only unusually large groups lose inner voices beforehand.
  const pool = [...notes]
  while (pool.length > MAX_GROUP) pool.splice(Math.floor(pool.length / 2), 1)
  for (let size = Math.min(pool.length, open.length); size > 0; size--) {
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

  // Viterbi over the events. A cell is a state plus the hand position it leaves: an all-open
  // state keeps the position it inherits, so it gets one cell per incoming position.
  type Cell = { cost: number; state: number; from: number; position: number | null }
  const layers: Cell[][] = []
  steps.forEach((step, t) => {
    const previous = layers[t - 1]
    const cells: Cell[] = []
    step.states.forEach((state, s) => {
      if (!previous) {
        cells.push({ cost: state.cost, state: s, from: -1, position: state.position })
        return
      }
      const byPosition = new Map<number | null, Cell>()
      previous.forEach((prev, k) => {
        const move =
          state.position !== null && prev.position !== null
            ? Math.abs(state.position - prev.position)
            : 0
        const cost = prev.cost + state.cost + COST.move * move
        const position = state.position ?? prev.position
        const known = byPosition.get(position)
        if (!known || cost < known.cost)
          byPosition.set(position, { cost, state: s, from: k, position })
      })
      cells.push(...byPosition.values())
    })
    layers.push(cells)
  })

  const chosen: number[] = []
  let k = (layers.at(-1) ?? []).reduce(
    (b, cell, i, all) => (cell.cost < (all[b]?.cost ?? Infinity) ? i : b),
    0,
  )
  for (let t = steps.length - 1; t >= 0; t--) {
    const cell = layers[t]?.[k]
    chosen[t] = cell?.state ?? 0
    k = cell?.from ?? 0
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

/**
 * The cost `assignTab` minimizes, for a finished tab: each event's fret height and stretch,
 * plus the hand's movement between fretted events (open strings leave it in place).
 */
export function tabCost(notes: readonly TabNote[], chordWindowSec = 0.035): number {
  let total = 0
  let hand: number | null = null
  for (const group of events(notes, chordWindowSec) as TabNote[][]) {
    const { cost, position } = shapeCost(group.map((n) => n.fret))
    total += cost + (position !== null && hand !== null ? COST.move * Math.abs(position - hand) : 0)
    hand = position ?? hand
  }
  return total
}

/** A sixteenth-note grid: where each note goes in the written tab. */
export interface TabGrid {
  stepsPerBar: number
  /** The sixteenth a time falls on, counted from the tab's first bar line (0). */
  slot: (time: number) => number
}

/** The first beat of the bar holding `beatIndex` (beats counted from the first downbeat), so
 * that a note a hair before a bar line still belongs to that bar. */
const barStart = (beatIndex: number, beatsPerBar: number) =>
  Math.floor((beatIndex + 1 / 8) / beatsPerBar) * beatsPerBar

/**
 * A grid at one fixed tempo from the first downbeat. It starts on the bar line of the bar
 * holding the first note (`firstNote`, default the downbeat): a pickup before the downbeat gets
 * its own bar, and silence before the first note gets none. Prefer `beatGrid` when the beats
 * are known: one tempo drifts away from a real recording within a minute.
 */
export function tabGrid(
  bpm: number,
  firstDownbeat = 0,
  beatsPerBar = 4,
  firstNote = firstDownbeat,
): TabGrid {
  const beat = 60 / bpm
  const origin = barStart((firstNote - firstDownbeat) / beat, beatsPerBar)
  return {
    stepsPerBar: 4 * beatsPerBar,
    slot: (time) => Math.max(0, Math.round(((time - firstDownbeat) / beat - origin) * 4)),
  }
}

/**
 * A grid that follows the detected beats: a note's place is interpolated between the beats
 * around it (four sixteenths per beat), so the tab stays in step with a recording whose tempo
 * wanders. Bars hold `beatsPerBar` beats from the first downbeat. Before the first and after
 * the last beat the nearest beat interval is extended. Null with fewer than two beats.
 */
export function beatGrid(
  beats: readonly number[],
  downbeats: readonly number[],
  beatsPerBar = 4,
  firstNote?: number,
): TabGrid | null {
  const times = [...beats].sort((a, b) => a - b)
  if (times.length < 2) return null
  // Beat indexes count from the first downbeat (the beat nearest to it).
  const anchorTime = downbeats[0] ?? times[0] ?? 0
  let anchor = 0
  times.forEach((t, i) => {
    if (Math.abs(t - anchorTime) < Math.abs((times[anchor] ?? 0) - anchorTime)) anchor = i
  })
  const last = times.length - 1
  const at = (i: number) => times[i] ?? 0
  const beatIndex = (time: number): number => {
    if (time <= at(0)) return (time - at(0)) / (at(1) - at(0)) - anchor
    if (time >= at(last)) return last + (time - at(last)) / (at(last) - at(last - 1)) - anchor
    let lo = 0
    let hi = last
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (at(mid) <= time) lo = mid
      else hi = mid
    }
    return lo + (time - at(lo)) / (at(hi) - at(lo)) - anchor
  }
  const origin = barStart(beatIndex(firstNote ?? at(anchor)), beatsPerBar)
  return {
    stepsPerBar: 4 * beatsPerBar,
    slot: (time) => Math.max(0, Math.round((beatIndex(time) - origin) * 4)),
  }
}

export interface GridPlacement {
  /** Each written note with its slot, in time order. */
  placed: { note: TabNote; slot: number }[]
  /** Notes that could not be written: another note on their string took their sixteenth and
   * the next one. */
  crowded: TabNote[]
}

/**
 * Puts the notes on the grid, one note per string per sixteenth. A note whose string is taken
 * in its sixteenth (a fast hammer-on, a triplet) moves to the next one when that is free;
 * otherwise it is listed as crowded rather than silently lost. Both writers use this, so the
 * text and the MusicXML always show the same notes.
 */
export function placeOnGrid(notes: readonly TabNote[], grid: TabGrid): GridPlacement {
  const taken = new Set<string>()
  const placed: GridPlacement['placed'] = []
  const crowded: TabNote[] = []
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.string - b.string)
  for (const note of sorted) {
    const first = grid.slot(note.start)
    const slot = [first, first + 1].find((s) => !taken.has(`${note.string}:${s}`))
    if (slot === undefined) {
      crowded.push(note)
      continue
    }
    taken.add(`${note.string}:${slot}`)
    placed.push({ note, slot })
  }
  return { placed, crowded }
}

const STRING_NAMES = ['E', 'A', 'D', 'G', 'B', 'e'] as const

/**
 * Plain-text tab, high e string on top, one column per sixteenth, `barsPerLine` bars a line:
 *
 *     e|-----0-------0--|
 *     B|---1---1---1----|
 */
export function tabToText(notes: readonly TabNote[], grid: TabGrid, barsPerLine = 4): string {
  const { placed } = placeOnGrid(notes, grid)
  if (placed.length === 0) return ''
  const lastSlot = Math.max(...placed.map((p) => p.slot))
  const bars = Math.floor(lastSlot / grid.stepsPerBar) + 1
  // Two characters per slot so that two-digit frets keep the columns aligned.
  const rows = STRING_NAMES.map(() => Array.from({ length: bars * grid.stepsPerBar }, () => '--'))
  for (const { note, slot } of placed) {
    const row = rows[note.string]
    if (row) row[slot] = String(note.fret).padEnd(2, '-')
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

/** Text for XML content: characters XML 1.0 does not allow (control characters, U+FFFE, lone
 * surrogates) are dropped, markup characters escaped. A file name can contain any of them. */
const escapeXml = (text: string) =>
  text
    .replace(/[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)

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
  const bySlot = new Map<number, TabNote[]>()
  for (const { note, slot } of placeOnGrid(notes, grid).placed) {
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), note])
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
