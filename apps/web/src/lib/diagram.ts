import { findBarres, type Voicing } from '@barrefree/theory'
import type { Chord as SvguitarChord, Finger } from 'svguitar'

/** Frets shown in a diagram. */
export const DIAGRAM_FRETS = 4

/**
 * Converts a voicing (index 0 = low E, frets relative to nut/capo) into svguitar's chord
 * format (string 1 = high E, frets relative to the diagram's first fret).
 */
export function toSvguitar(voicing: Voicing, title?: string): SvguitarChord {
  const fretted = voicing.frets.filter((f): f is number => f !== null && f > 0)
  const maxFret = fretted.length ? Math.max(...fretted) : 0
  const minFret = fretted.length ? Math.min(...fretted) : 0
  const position = maxFret > DIAGRAM_FRETS ? minFret : 1
  const rel = (fret: number) => fret - position + 1
  const stringOf = (index: number) => voicing.frets.length - index

  const fingers: Finger[] = voicing.frets.map((fret, i): Finger => {
    if (fret === null) return [stringOf(i), 'x']
    if (fret === 0) return [stringOf(i), 0]
    const finger = voicing.fingers[i]
    return finger ? [stringOf(i), rel(fret), String(finger)] : [stringOf(i), rel(fret)]
  })
  const found = findBarres(voicing.frets, voicing.fingers)
  const barres = found.map((b) => ({
    fromString: stringOf(b.from),
    toString: stringOf(b.to),
    fret: rel(b.fret),
    text: String(voicing.fingers[b.from] ?? 1),
  }))
  // Strings under a barre are drawn by the barre itself.
  const covered = new Set(
    found.flatMap((b) =>
      voicing.frets.flatMap((f, i) =>
        i >= b.from && i <= b.to && f === b.fret ? [stringOf(i)] : [],
      ),
    ),
  )
  return {
    fingers: fingers.filter(([s, f]) => !(typeof f === 'number' && f > 0 && covered.has(s))),
    barres,
    position,
    ...(title === undefined ? {} : { title }),
  }
}
