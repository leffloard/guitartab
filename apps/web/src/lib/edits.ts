import {
  formatChordSymbol,
  formatHarte,
  parseChordLabel,
  transpose,
  type Spelling,
} from '@barrefree/theory'

/** The pitch frame a chart shows chords in, relative to the analysis (see useArrangement). */
export interface Frame {
  offset: number
  spelling: Spelling
}

export const NO_CHORD = 'N'

/**
 * A stored label (Harte, at the recording's pitch) as the chart shows it: moved into the frame
 * and written as a chord symbol ("Em", "G/B"). No-chord and unreadable labels come back as is.
 */
export function labelInFrame(
  label: string,
  frame: Frame,
  noteNames: 'letter' | 'solfege' = 'letter',
): string {
  const parsed = parseChordLabel(label)
  if (parsed.kind === 'no-chord') return 'N.C.'
  if (parsed.kind !== 'chord') return label
  return formatChordSymbol(transpose(parsed.chord, frame.offset), {
    spelling: frame.spelling,
    noteNames,
  })
}

/**
 * What the user typed, read in the chart's frame, as the label to store: canonical Harte at the
 * recording's pitch ("N" for no chord), so the fix keeps meaning the same chord when the capo or
 * transposition changes, and equal spellings compare equal. Null if it is not a chord.
 */
export function labelFromFrame(text: string, frame: Frame): string | null {
  const parsed = parseChordLabel(text)
  if (parsed.kind === 'no-chord') return NO_CHORD
  if (parsed.kind !== 'chord') return null
  return formatHarte(transpose(parsed.chord, -frame.offset))
}
