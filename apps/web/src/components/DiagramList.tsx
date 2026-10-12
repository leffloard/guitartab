import { chordKey, type TransformResult } from '@barrefree/theory'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import {
  choiceName,
  requestedName,
  type EffectiveChoice,
  type NameOptions,
} from '../lib/arrangement'
import { ChordDiagram } from './ChordDiagram'

interface Props {
  choices: EffectiveChoice[]
  result: TransformResult
  names: NameOptions
  /** Symbol key of the chord selected in the sheet. */
  selected: string | null
  onPick: (choice: EffectiveChoice, voicingId: string | null) => void
}

const ARROWS = { previous: '‹', next: '›' } as const

/** One card per distinct chord: diagram, name, and arrows to browse alternative shapes. */
export function DiagramList({ choices, result, names, selected, onPick }: Props) {
  const { t } = useTranslation()
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (selected === null) return
    const card = list.current?.querySelector<HTMLElement>('.is-selected')
    card?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [selected])
  return (
    <section className="diagrams" aria-labelledby="diagrams-title">
      <h2 id="diagrams-title">{t('diagrams.title')}</h2>
      <ul className="diagram-grid" ref={list}>
        {choices.map((choice) => {
          const name = choiceName(choice, result, { ...names, display: 'shapes' })
          const requested = requestedName(choice, result, names)
          const total = choice.candidates.length
          const index = choice.candidateIndex
          const step = (delta: number) => {
            if (total === 0) return
            const next = choice.candidates[(Math.max(index, 0) + delta + total) % total]
            if (next) onPick(choice, next.entry.voicing.id)
          }
          return (
            <li
              key={choice.preferenceKey}
              className={`diagram-card${selected === chordKey(choice.chord) ? ' is-selected' : ''}`}
              data-substituted={choice.substituted || undefined}
            >
              <div className="diagram-name">{name}</div>
              <div className="diagram-sub">
                {choice.substituted || (result.option?.capo ?? 0) > 0
                  ? t('diagrams.for', { chord: requested })
                  : ' '}
              </div>
              <ChordDiagram voicing={choice.voicing} label={t('diagrams.label', { chord: name })} />
              {total > 1 && (
                <div className="diagram-nav">
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    aria-label={t('diagrams.previous')}
                  >
                    {ARROWS.previous}
                  </button>
                  <span>{t('diagrams.position', { index: index + 1, total })}</span>
                  <button type="button" onClick={() => step(1)} aria-label={t('diagrams.next')}>
                    {ARROWS.next}
                  </button>
                </div>
              )}
              {choice.overridden && (
                <button type="button" className="link" onClick={() => onPick(choice, null)}>
                  {t('diagrams.reset')}
                </button>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
