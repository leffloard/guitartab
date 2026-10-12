import type { Voicing } from '@barrefree/theory'
import { useEffect, useRef } from 'react'
import { SVGuitarChord } from 'svguitar'

import { DIAGRAM_FRETS, toSvguitar } from '../lib/diagram'

interface Props {
  voicing: Voicing
  /** Accessible description, e.g. "Chord diagram for Fmaj7". */
  label: string
}

const COLOR = '#f2f2f2'

/** A chord box drawn by svguitar. Re-created whenever the voicing changes. */
export function ChordDiagram({ voicing, label }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const container = ref.current
    if (!container) return
    const chart = new SVGuitarChord(container)
    try {
      chart
        .configure({
          frets: DIAGRAM_FRETS,
          color: COLOR,
          titleColor: COLOR,
          fingerTextColor: '#111111',
          fretLabelColor: COLOR,
          backgroundColor: 'none',
          fontFamily: 'system-ui, sans-serif',
          fingerSize: 0.75,
          fixedDiagramPosition: true,
        })
        .chord(toSvguitar(voicing))
        .draw()
    } catch {
      // Rendering needs SVG layout APIs (absent in some test environments); leave it empty.
    }
    return () => chart.remove()
  }, [voicing])
  return <div ref={ref} className="diagram" role="img" aria-label={label} />
}
