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
  /** Scroll the selected card into view (off while a song plays, so the page stays put). */
  scrollToSelected?: boolean
  onPick: (choice: EffectiveChoice, voicingId: string | null) => void
}

const ARROWS = { previous: '‹', next: '›' } as const

/** One card per distinct chord: diagram, name, and arrows to browse alternative shapes. */
export function DiagramList({
  choices,
  result,
  names,
  selected,
  scrollToSelected = true,
  onPick,
}: Props) {
  const { t } = useTranslation()
  const list = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (selected === null || !scrollToSelected) return
    const card = list.current?.querySelector<HTMLElement>('.is-selected')
    card?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' })
  }, [selected, scrollToSelected])
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
            // From outside the list, "next" starts at the first shape and "previous" at the last.
            const from = index >= 0 ? index : delta > 0 ? -1 : total
            const next = choice.candidates[(from + delta + total) % total]
            if (next) onPick(choice, next.entry.voicing.id)
          }
          const frets = choice.voicing.frets.map((f) => f ?? 'x').join(' ')
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
              <ChordDiagram
                voicing={choice.voicing}
                label={t('diagrams.label', { chord: name, frets })}
              />
              {total > 1 && (
                <div className="diagram-nav">
                  <button
                    type="button"
                    onClick={() => step(-1)}
                    aria-label={t('diagrams.previous')}
                  >
                    {ARROWS.previous}
                  </button>
                  <span aria-live="polite">
                    {t('diagrams.position', { index: index + 1, total })}
                  </span>
                  <button type="button" onClick={() => step(1)} aria-label={t('diagrams.next')}>
                    {ARROWS.next}
                  </button>
                </div>
              )}
              {choice.overridden && (
                <button
                  type="button"
                  className="link"
                  onClick={(e) => {
                    // This button disappears with the reset: keep keyboard focus in the card.
                    const card = e.currentTarget.closest('li')
                    onPick(choice, null)
                    card
                      ?.querySelector<HTMLButtonElement>('.diagram-nav button:last-of-type')
                      ?.focus()
                  }}
                >
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
