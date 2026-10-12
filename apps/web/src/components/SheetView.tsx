import type { RenderedLine } from '@barrefree/theory'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  lines: RenderedLine[]
  /** For each chord token index: the arrangement's symbol key (null for no-chord / invalid). */
  symbolOfToken: (index: number) => string | null
  substitutedSymbols: ReadonlySet<string>
  /** Symbol key of the selected chord. */
  selected: string | null
  onSelect: (symbolKey: string) => void
}

/**
 * The chord sheet in a monospace block. Chord names are buttons placed exactly where the
 * renderer put them, so the columns over the lyrics are preserved.
 */
export function SheetView({ lines, symbolOfToken, substitutedSymbols, selected, onSelect }: Props) {
  const { t } = useTranslation()
  return (
    <pre className="sheet" aria-label={t('sheet.label')}>
      {lines.map((line, i) => (
        <span key={i} className={`line line-${line.kind}`}>
          {line.chords.length === 0
            ? line.text
            : renderChords(line, symbolOfToken, substitutedSymbols, selected, onSelect)}
          {'\n'}
        </span>
      ))}
    </pre>
  )
}

function renderChords(
  line: RenderedLine,
  symbolOfToken: Props['symbolOfToken'],
  substituted: ReadonlySet<string>,
  selected: string | null,
  onSelect: Props['onSelect'],
) {
  const parts: ReactNode[] = []
  let at = 0
  for (const c of line.chords) {
    if (c.start > at) parts.push(line.text.slice(at, c.start))
    const name = line.text.slice(c.start, c.end)
    const symbol = symbolOfToken(c.token.index)
    parts.push(
      symbol === null ? (
        name
      ) : (
        <button
          key={c.start}
          type="button"
          className={`chord${substituted.has(symbol) ? ' is-substituted' : ''}${
            selected === symbol ? ' is-selected' : ''
          }`}
          aria-pressed={selected === symbol}
          onClick={() => onSelect(symbol)}
        >
          {name}
        </button>
      ),
    )
    at = c.end
  }
  if (at < line.text.length) parts.push(line.text.slice(at))
  return parts
}
