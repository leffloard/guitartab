/**
 * Timed chords laid out for playing along: which chord sounds now, how many beats until the next
 * change, and bars for a chord chart (text or ChordPro). Times are seconds; chords are sorted,
 * non-overlapping segments as the analyzer returns them.
 */

export interface TimedChord {
  start: number
  end: number
  label: string
  confidence?: number
}

export interface Span {
  start: number
  end: number
}

/** Index of the segment sounding at `time`, or −1 (before the first, after the last, or in a gap). */
export function chordIndexAt(chords: readonly Span[], time: number): number {
  let lo = 0
  let hi = chords.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const c = chords[mid]
    if (!c) break
    if (time < c.start) hi = mid - 1
    else if (time >= c.end) lo = mid + 1
    else return mid
  }
  return -1
}

/**
 * The next segment after `time` that plays something other than what sounds now, skipping
 * no-chord segments (a gap is not something to prepare a hand shape for).
 */
export function nextChordIndex(
  chords: readonly TimedChord[],
  time: number,
  isNoChord: (label: string) => boolean = (l) => /^(N|X)$/.test(l),
): number {
  const current = chordIndexAt(chords, time)
  const now = current >= 0 ? chords[current]?.label : undefined
  for (let i = current >= 0 ? current + 1 : 0; i < chords.length; i++) {
    const c = chords[i]
    if (!c || c.start <= time) continue
    if (!isNoChord(c.label) && c.label !== now) return i
  }
  return -1
}

/** Beats strictly after `time` up to and including `until` (with 50 ms tolerance). */
export function beatsBetween(beats: readonly number[], time: number, until: number): number {
  let n = 0
  for (const b of beats) if (b > time + 0.05 && b <= until + 0.05) n++
  return n
}

export interface Bar {
  start: number
  end: number
  /** Beat times inside the bar (the first is the downbeat, unless this is a pickup bar). */
  beats: number[]
}

/**
 * Bars from the downbeats; without downbeats, every `beatsPerBar` beats; without beats, one bar
 * for the whole song. Music before the first downbeat becomes a pickup bar.
 */
export function barsFromBeats(
  beats: readonly number[],
  downbeats: readonly number[],
  duration: number,
  beatsPerBar = 4,
): Bar[] {
  const starts =
    downbeats.length >= 2
      ? [...downbeats]
      : beats.filter((_, i) => i % Math.max(1, beatsPerBar) === 0)
  if (starts.length === 0) return [{ start: 0, end: duration, beats: [] }]
  const first = starts[0] ?? 0
  if (first > 0.05) starts.unshift(0)
  return starts
    .map((start, i) => {
      const end = starts[i + 1] ?? duration
      return { start, end, beats: beats.filter((b) => b >= start - 0.05 && b < end - 0.05) }
    })
    .filter((bar) => bar.end > bar.start)
}

export interface BarChord {
  /** Index into the chord list. */
  index: number
  /** Beat of the bar where the chord starts (0-based); 0 for a chord carried over. */
  beat: number
  /** The chord started in an earlier bar and is still sounding. */
  carried: boolean
  /** A no-chord segment (silence, a break): written N.C. */
  rest: boolean
}

export interface ChartBar extends Bar {
  chords: BarChord[]
}

export interface LayoutOptions {
  isNoChord?: (label: string) => boolean
  /** Beats per bar, for placing chords in bars that have no beat times. */
  beatsPerBar?: number
}

export const isNoChordLabel = (label: string): boolean => /^(N|X)$/.test(label)

/** Places every segment in the bars it sounds in; no-chord segments become rests. */
export function layoutBars(
  bars: readonly Bar[],
  chords: readonly TimedChord[],
  options: LayoutOptions = {},
): ChartBar[] {
  const { isNoChord = isNoChordLabel, beatsPerBar = 4 } = options
  return bars.map((bar) => {
    const inBar: BarChord[] = []
    chords.forEach((c, index) => {
      if (c.end <= bar.start + 0.05 || c.start >= bar.end - 0.05) return
      const carried = c.start < bar.start - 0.05
      const beat = carried ? 0 : beatOf(bar, c.start, beatsPerBar)
      inBar.push({ index, beat, carried, rest: isNoChord(c.label) })
    })
    return { ...bar, chords: inBar }
  })
}

/**
 * The beat a time falls on: the nearest beat time, or, in a bar without beat times, its share
 * of the bar.
 */
function beatOf(bar: Bar, time: number, beatsPerBar: number): number {
  if (bar.beats.length === 0) {
    const share = (time - bar.start) / Math.max(bar.end - bar.start, 1e-9)
    return Math.min(beatsPerBar - 1, Math.max(0, Math.floor(share * beatsPerBar + 0.25)))
  }
  let best = 0
  let bestDistance = Infinity
  bar.beats.forEach((b, i) => {
    const d = Math.abs(b - time)
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  })
  return best
}

/**
 * Drops the bars before the first chord and after the last one (silent lead-in and tail). A bar
 * with a segment for which `keep` is true stays (a user's fix to "no chord" must stay visible).
 */
export function trimEmptyBars(
  bars: readonly ChartBar[],
  keep: (index: number) => boolean = () => false,
): ChartBar[] {
  const counts = (bar: ChartBar | undefined) =>
    bar?.chords.some((c) => !c.rest || keep(c.index)) ?? false
  const first = bars.findIndex(counts)
  if (first < 0) return []
  let last = bars.length - 1
  while (last > first && !counts(bars[last])) last--
  return bars.slice(first, last + 1)
}

export const REST = 'N.C.'

export interface ChartOptions {
  barsPerLine?: number
  /** Beats per bar for bars without beat times. */
  beatsPerBar?: number
  /** How to write a no-chord segment (default `N.C.`). */
  rest?: string
}

/**
 * A plain-text chord chart, one slot per beat: `| C . . . | G . Am . |`. A dot holds the chord
 * before it and `N.C.` marks a break; a line that starts inside a held chord repeats its name,
 * so every line reads on its own. No chord is ever left out: one that lands on a taken slot
 * moves to the next free one (or shares the slot when the bar is full).
 */
export function chartToText(
  bars: readonly ChartBar[],
  name: (index: number) => string,
  options: ChartOptions = {},
): string {
  const { barsPerLine = 4, beatsPerBar = 4, rest = REST } = options
  const label = (c: BarChord) => (c.rest ? rest : name(c.index))
  const lines: string[] = []
  for (let i = 0; i < bars.length; i += barsPerLine) {
    const cells = bars.slice(i, i + barsPerLine).map((bar, k) => {
      const slots: string[] = Array.from(
        { length: Math.max(1, bar.beats.length || beatsPerBar) },
        () => '.',
      )
      const starts = bar.chords.filter((c) => !c.carried)
      const placed = slotsInOrder(starts, slots.length)
      starts.forEach((c, i) => {
        const at = placed[i] ?? 0
        slots[at] = slots[at] === '.' ? label(c) : `${slots[at] ?? ''} ${label(c)}`
      })
      const held = bar.chords.find((c) => c.carried)
      if (k === 0 && held && slots[0] === '.') slots[0] = label(held)
      return ` ${slots.join(' ')} `
    })
    lines.push(`|${cells.join('|')}|`)
  }
  return lines.join('\n')
}

/**
 * One slot per chord, as close to its beat as possible but in time order: a chord on a taken
 * slot moves right, and chords past the end push earlier ones left. With more chords than slots
 * the first slot is shared.
 */
function slotsInOrder(chords: readonly BarChord[], slots: number): number[] {
  const at: number[] = []
  chords.forEach((c, i) =>
    at.push(Math.max(Math.min(c.beat, slots - 1), i > 0 ? (at[i - 1] ?? 0) + 1 : 0)),
  )
  for (let i = at.length - 1; i >= 0; i--) {
    at[i] = Math.min(at[i] ?? 0, i < at.length - 1 ? (at[i + 1] ?? slots) - 1 : slots - 1)
  }
  return at.map((s) => Math.max(0, s))
}

/** ChordPro chart: the same bars with the chords in brackets (`| [C] . . . | [G] . [Am] . |`). */
export function chartToChordPro(
  bars: readonly ChartBar[],
  name: (index: number) => string,
  directives: { title?: string; capo?: number; tempo?: number; time?: string } = {},
  options: ChartOptions = {},
): string {
  const head: string[] = []
  if (directives.title) head.push(`{title: ${directives.title}}`)
  if (directives.capo) head.push(`{capo: ${directives.capo}}`)
  if (directives.tempo) head.push(`{tempo: ${Math.round(directives.tempo)}}`)
  if (directives.time) head.push(`{time: ${directives.time}}`)
  const body = chartToText(bars, (i) => `[${name(i)}]`, { rest: `[${REST}]`, ...options })
  return [...head, body].join('\n') + '\n'
}
