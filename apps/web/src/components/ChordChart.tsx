import { REST, type BarChord, type ChartBar, type TimedChord } from '@barrefree/theory'
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

/** A chord of a bar and the beat columns it covers (CSS grid lines, 1-based). */
interface Cell {
  chord: BarChord
  name: string
  from: number
  to: number
}

/**
 * Where each chord of a bar goes: on its beat's column, running until the next chord starts,
 * so its name has the room of all its beats. Columns stay equal, so position shows the beat.
 */
function barCells(bar: ChartBar, nameOf: (chord: BarChord) => string): Cell[] {
  const columns = Math.max(1, bar.beats.length || 4)
  const column = (beat: number) => Math.min(beat, columns - 1) + 1
  const starts = bar.chords.filter((c) => !c.carried)
  return starts.map((chord, i) => {
    const from = column(chord.beat)
    const next = starts[i + 1]
    return {
      chord,
      name: nameOf(chord),
      from,
      to: Math.max(next ? column(next.beat) : columns + 1, from + 1),
    }
  })
}

/** One beat of the narrowest bar (9rem, four beats), and a rough bold chord-name character. */
const BEAT_PX = 32
const CHAR_PX = 12
/** The chord button's own padding and border. */
const BUTTON_PX = 10

const fits = (cell: Cell) =>
  cell.name.length * CHAR_PX + BUTTON_PX <= (cell.to - cell.from) * BEAT_PX

/**
 * The song as bars of chords, one column per beat. Tap a chord to jump there, or, in edit mode,
 * to correct it. Uncertain chords are marked so they can be checked by ear; breaks show as
 * N.C., which can be corrected too (a chord the analyzer missed).
 */
export function ChordChart(p: Props) {
  const { t } = useTranslation()
  const nameOf = (c: BarChord) =>
    c.rest ? REST : (p.nameOf(c.index) ?? p.chords[c.index]?.label ?? '?')
  const layout = p.bars.map((bar) => barCells(bar, nameOf))
  // A long name on a single beat would be cut: then every bar gets wider (all the same width,
  // so the chart stays a grid and the bars stay in order).
  const dense = layout.some((cells) => cells.some((c) => !c.chord.rest && !fits(c)))
  return (
    <ol
      className={`chart${dense ? ' is-dense' : ''}${p.editing ? ' is-editing' : ''}`}
      aria-label={t('chart.label')}
    >
      {p.bars.map((bar, b) => {
        const columns = Math.max(1, bar.beats.length || 4)
        const cells = layout[b] ?? []
        const held = bar.chords.find((c) => c.carried)
        const firstStart = cells[0]?.from ?? columns + 1
        return (
          <li
            key={b}
            className={`bar${b === p.currentBar ? ' is-current' : ''}`}
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {held && !held.rest && firstStart > 1 && (
              <span className="held" aria-hidden="true" style={{ gridColumn: `1 / ${firstStart}` }}>
                {p.nameOf(held.index) ?? ''}
              </span>
            )}
            {cells.map(({ chord: c, name, from, to }) => {
              const chord = p.chords[c.index]
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
                  style={{ gridColumn: `${from} / ${to}` }}
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
