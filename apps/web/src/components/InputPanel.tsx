import type { ChordSheet } from '@barrefree/theory'
import { useTranslation } from 'react-i18next'

import { EXAMPLE_SHEET } from '../lib/example'

interface Props {
  text: string
  onText: (text: string) => void
  sheet: ChordSheet
}

export function InputPanel({ text, onText, sheet }: Props) {
  const { t } = useTranslation()
  const count = sheet.chords.filter((c) => c.parsed.kind === 'chord').length
  return (
    <section className="input" aria-labelledby="input-title">
      <div className="section-head">
        <h2 id="input-title">{t('input.title')}</h2>
        <div className="actions">
          <button type="button" onClick={() => onText(EXAMPLE_SHEET)}>
            {t('input.example')}
          </button>
          <button type="button" onClick={() => onText('')} disabled={text === ''}>
            {t('input.clear')}
          </button>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => onText(e.target.value)}
        placeholder={t('input.placeholder')}
        aria-label={t('input.title')}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={10}
      />
      <p className="hint">
        {count === 0
          ? t('input.empty')
          : `${t('input.found', { count })} · ${t(`input.format.${sheet.format}`)}`}
      </p>
    </section>
  )
}
