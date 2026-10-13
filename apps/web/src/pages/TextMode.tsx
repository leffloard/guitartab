import {
  isCapoLine,
  parseChordSheet,
  renderChordSheet,
  renderedToText,
  sheetProgression,
  toChordPro,
  type ChordToken,
} from '@barrefree/theory'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Controls } from '../components/Controls'
import { DiagramList } from '../components/DiagramList'
import { InputPanel } from '../components/InputPanel'
import { SheetView } from '../components/SheetView'
import type { Settings } from '../hooks/useSettings'
import { useArrangement, type ArrangementView } from '../hooks/useArrangement'
import { useWakeLock } from '../hooks/useWakeLock'
import { copyText } from '../lib/clipboard'
import { readStored, writeStored } from '../lib/storage'

const DRAFT_KEY = 'barrefree.draft'
const VIEW_KEY = 'barrefree.textView'
const isString = (v: unknown): v is string => typeof v === 'string'
const isView = (v: unknown): v is Partial<ArrangementView> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Paste a chord sheet, get it back barre-free with the columns kept. */
export function TextMode({ settings }: { settings: Settings }) {
  const { t } = useTranslation()
  const [text, setTextState] = useState(() => readStored(DRAFT_KEY, '', isString))
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState<'text' | 'chordpro' | null>(null)

  const setText = useCallback((value: string) => {
    setTextState(value)
    setSelected(null)
    writeStored(DRAFT_KEY, value === '' ? undefined : value)
  }, [])

  const deferredText = useDeferredValue(text)
  const sheet = useMemo(() => parseChordSheet(deferredText), [deferredText])
  const progression = useMemo(() => sheetProgression(sheet), [sheet])
  const identity = useMemo(() => sheet.chords.map((c) => c.text).join('\u0000'), [sheet])
  // Chords written for a capo are shapes: what they sound like is that many semitones higher.
  // The controls outlive the page (Library and back), like the draft does.
  const [initialView] = useState(() => readStored(VIEW_KEY, {}, isView))
  const arrangement = useArrangement(progression, identity, {
    sourceCapo: sheet.meta.capo ?? 0,
    noteNames: settings.noteNames,
    initial: initialView,
  })
  const { result, choices, names, option, capoOn, shapesShown, view } = arrangement
  const viewKey = JSON.stringify(view)
  useEffect(() => writeStored(VIEW_KEY, JSON.parse(viewKey) as ArrangementView), [viewKey])
  useWakeLock(settings.keepScreenOn && sheet.chords.length > 0)

  const replace = (token: ChordToken) => arrangement.nameOf(token.index) ?? token.text
  // The source's own capo lines are replaced by the capo note above the sheet.
  const shown = useMemo(
    () => ({ ...sheet, lines: sheet.lines.filter((l) => !isCapoLine(l)) }),
    [sheet],
  )
  const lines = renderChordSheet(shown, replace)

  const copy = async (kind: 'text' | 'chordpro') => {
    // Shapes need the capo to sound right; sounding names must not carry one.
    const capoForCopy = shapesShown && option ? option.capo : 0
    const content =
      kind === 'text'
        ? (capoForCopy > 0 ? `${t('export.capoHeader', { capo: capoForCopy })}\n\n` : '') +
          renderedToText(lines)
        : toChordPro(sheet, replace, capoForCopy > 0 ? { capo: capoForCopy } : {})
    if (await copyText(content)) {
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    }
  }

  return (
    <>
      <InputPanel text={text} onText={setText} sheet={sheet} />

      {sheet.chords.length > 0 && (
        <>
          <Controls {...arrangement.controls} keyName={arrangement.keyLabel} />

          <section className="result" aria-labelledby="result-title">
            <div className="section-head">
              <h2 id="result-title">{t('sheet.title')}</h2>
              <div className="actions">
                <button type="button" onClick={() => void copy('text')}>
                  {copied === 'text' ? t('actions.copied') : t('actions.copyText')}
                </button>
                <button type="button" onClick={() => void copy('chordpro')}>
                  {copied === 'chordpro' ? t('actions.copied') : t('actions.copyChordPro')}
                </button>
              </div>
            </div>
            {option && (
              <p className="capo-note">
                {capoOn
                  ? t(view.display === 'shapes' ? 'sheet.capoNote' : 'sheet.capoNoteSounding', {
                      capo: option.capo,
                    })
                  : t('sheet.noCapoNote')}
              </p>
            )}
            <SheetView
              lines={lines}
              symbolOfToken={arrangement.symbolOf}
              isChanged={arrangement.isChanged}
              selected={selected}
              onSelect={(key) => setSelected((s) => (s === key ? null : key))}
            />
          </section>

          {option && (
            <DiagramList
              choices={[...choices.values()]}
              result={result}
              names={names}
              selected={selected}
              onPick={arrangement.pickVoicing}
            />
          )}
        </>
      )}
    </>
  )
}
