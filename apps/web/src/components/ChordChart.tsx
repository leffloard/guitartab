import { REST, type ChartBar, type TimedChord } from '@barrefree/theory'
import { useTranslation } from 'react-i18next'

interface Props {
  bars: ChartBar[]
  chords: TimedChord[]
  nameOf: (index: number) => string | null
  currentBar: number
  currentChord: number
  /** Below this confidence a chord is marked for checking. */
  threshold: number
  isEdited: (index: number) => boolean
  isChanged: (index: number) => boolean
  editing: boolean
  onSeek: (index: number) => void
  onEdit: (index: number) => void
}

/**
 * The song as bars of chords, one column per beat. Tap a chord to jump there, or, in edit mode,
 * to correct it. Uncertain chords are marked so they can be checked by ear; breaks show as
 * N.C., which can be corrected too (a chord the analyzer missed).
 */
export function ChordChart(p: Props) {
  const { t } = useTranslation()
  return (
    <ol className={`chart${p.editing ? ' is-editing' : ''}`} aria-label={t('chart.label')}>
      {p.bars.map((bar, b) => {
        const columns = Math.max(1, bar.beats.length || 4)
        const starts = bar.chords.filter((c) => !c.carried)
        const held = bar.chords.find((c) => c.carried)
        return (
          <li
            key={b}
            className={`bar${b === p.currentBar ? ' is-current' : ''}`}
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {held && !held.rest && !starts.some((c) => c.beat === 0) && (
              <span className="held" aria-hidden="true" style={{ gridColumn: 1 }}>
                {p.nameOf(held.index) ?? ''}
              </span>
            )}
            {starts.map((c) => {
              const chord = p.chords[c.index]
              const name = c.rest ? REST : (p.nameOf(c.index) ?? chord?.label ?? '?')
              const uncertain =
                !c.rest && !p.isEdited(c.index) && (chord?.confidence ?? 1) < p.threshold
              const label = c.rest
                ? t('chart.rest')
                : uncertain
                  ? t('chart.uncertainChord', { chord: name })
                  : name
              return (
                <button
                  key={c.index}
                  type="button"
                  className={chordClass({
                    current: c.index === p.currentChord,
                    rest: c.rest,
                    uncertain,
                    edited: p.isEdited(c.index),
                    substituted: p.isChanged(c.index),
                  })}
                  style={{ gridColumn: Math.min(c.beat, columns - 1) + 1 }}
                  aria-label={label}
                  aria-current={c.index === p.currentChord ? 'true' : undefined}
                  onClick={() => (p.editing ? p.onEdit(c.index) : p.onSeek(c.index))}
                >
                  {name}
                </button>
              )
            })}
          </li>
        )
      })}
    </ol>
  )
}

function chordClass(
  state: Record<'current' | 'rest' | 'uncertain' | 'edited' | 'substituted', boolean>,
) {
  const flags = Object.entries(state).filter(([, on]) => on)
  return ['chart-chord', ...flags.map(([name]) => `is-${name}`)].join(' ')
}
