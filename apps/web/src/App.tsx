import {
  isCapoLine,
  LAMBDA_STOPS,
  parseChordSheet,
  renderChordSheet,
  renderedToText,
  sheetProgression,
  spellPitchClass,
  toChordPro,
  toSolfege,
  transform,
  type ChordToken,
  type Mode,
} from '@barrefree/theory'
import { useCallback, useDeferredValue, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Controls } from './components/Controls'
import { DiagramList } from './components/DiagramList'
import { InputPanel } from './components/InputPanel'
import { SettingsPanel } from './components/SettingsPanel'
import { SheetView } from './components/SheetView'
import { UpdatePrompt } from './components/UpdatePrompt'
import { useSettings } from './hooks/useSettings'
import { useVoicingPreferences } from './hooks/useVoicingPreferences'
import { useWakeLock } from './hooks/useWakeLock'
import {
  choiceName,
  effectiveChoices,
  keyName,
  playsExactly,
  symbolKey,
  type ChordDisplay,
  type EffectiveChoice,
} from './lib/arrangement'
import { readStored, writeStored } from './lib/storage'

const DRAFT_KEY = 'barrefree.draft'
const DEFAULT_LAMBDA_INDEX = 2 // λ = 10
const isString = (v: unknown): v is string => typeof v === 'string'

export function App() {
  const { t } = useTranslation()
  const [settings, updateSettings] = useSettings()
  const [preferences, setPreference] = useVoicingPreferences()

  const [text, setTextState] = useState(() => readStored(DRAFT_KEY, '', isString))
  const [mode, setMode] = useState<Mode>('easy')
  const [lambdaIndex, setLambdaIndex] = useState(DEFAULT_LAMBDA_INDEX)
  const [noCapo, setNoCapo] = useState(false)
  const [capoPick, setCapoPick] = useState<{ capo: number; for: string } | null>(null)
  const [shift, setShift] = useState(0)
  const [display, setDisplay] = useState<ChordDisplay>('shapes')
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState<'text' | 'chordpro' | null>(null)

  const setText = useCallback((value: string) => {
    setTextState(value)
    setSelected(null)
    writeStored(DRAFT_KEY, value === '' ? undefined : value)
  }, [])

  const deferredText = useDeferredValue(text)
  const sheet = useMemo(() => parseChordSheet(deferredText), [deferredText])
  // Chords written for a capo are shapes: what they sound like is that many semitones higher.
  const sourceCapo = sheet.meta.capo ?? 0
  const lambda = LAMBDA_STOPS[lambdaIndex] ?? 10
  // A capo pick holds only for the arrangement it was made for; editing lyrics keeps it.
  const arrangement = [mode, noCapo, shift, sourceCapo, ...sheet.chords.map((c) => c.text)].join(
    '\u0000',
  )
  const capo = capoPick?.for === arrangement ? capoPick.capo : null
  const result = useMemo(
    () =>
      transform(sheetProgression(sheet), {
        mode,
        lambda,
        transpose: shift + sourceCapo,
        ...(noCapo ? { capoRange: [0, 0] as const } : {}),
        ...(capo === null ? {} : { capo }),
      }),
    [sheet, mode, lambda, shift, sourceCapo, noCapo, capo],
  )
  const choices = useMemo(
    () => effectiveChoices(result, lambda, preferences),
    [result, lambda, preferences],
  )
  useWakeLock(settings.keepScreenOn && sheet.chords.length > 0)

  const names = { display, noteNames: settings.noteNames } as const
  const choiceOfToken = (token: ChordToken): EffectiveChoice | undefined => {
    const item = result.items[token.index]
    return item?.input ? choices.get(symbolKey(result, item.input)) : undefined
  }
  const replace = (token: ChordToken) => {
    const choice = choiceOfToken(token)
    return choice ? choiceName(choice, result, names) : token.text
  }
  // The source's own capo lines are replaced by the capo note above the sheet.
  const shown = useMemo(
    () => ({ ...sheet, lines: sheet.lines.filter((l) => !isCapoLine(l)) }),
    [sheet],
  )
  const lines = renderChordSheet(shown, replace)
  const symbolOfToken = (index: number) => {
    const item = result.items[index]
    return item?.input && choices.has(symbolKey(result, item.input))
      ? symbolKey(result, item.input)
      : null
  }
  const isChanged = (index: number) => {
    const item = result.items[index]
    const choice = item?.input ? choices.get(symbolKey(result, item.input)) : undefined
    return item?.input && choice ? !playsExactly(item.input, choice, result) : false
  }

  const option = result.option
  const capoOn = option !== null && option.capo > 0
  const shapesShown = display === 'shapes' && capoOn
  const keyLabel =
    sheet.chords.length > 0
      ? keyName(shapesShown ? result.key.shape : result.key.input, (pc) => {
          const name = spellPitchClass(
            pc,
            shapesShown ? result.spelling.shape : result.spelling.input,
          )
          return settings.noteNames === 'solfege' ? toSolfege(name) : name
        })
      : null

  const copy = async (kind: 'text' | 'chordpro') => {
    // Shapes need the capo to sound right; sounding names must not carry one.
    const capoForCopy = shapesShown && option ? option.capo : 0
    const content =
      kind === 'text'
        ? (capoForCopy > 0 ? `${t('export.capoHeader', { capo: capoForCopy })}\n\n` : '') +
          renderedToText(lines)
        : toChordPro(sheet, replace, capoForCopy > 0 ? { capo: capoForCopy } : {})
    try {
      await navigator.clipboard.writeText(content)
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      // clipboard blocked: nothing to do
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>{t('app.title')}</h1>
          <p className="tagline">{t('app.tagline')}</p>
        </div>
        <SettingsPanel settings={settings} onChange={updateSettings} />
      </header>

      <main className="layout">
        <InputPanel text={text} onText={setText} sheet={sheet} />

        {sheet.chords.length > 0 && (
          <>
            <Controls
              mode={mode}
              onMode={setMode}
              lambdaIndex={lambdaIndex}
              onLambdaIndex={setLambdaIndex}
              alternatives={result.alternatives}
              capo={capo}
              onCapo={(c) => setCapoPick({ capo: c, for: arrangement })}
              noCapo={noCapo}
              onNoCapo={setNoCapo}
              transpose={shift}
              onTranspose={(v) => setShift(Math.max(-11, Math.min(11, v)))}
              display={display}
              onDisplay={setDisplay}
              keyName={keyLabel}
              infeasible={option === null}
            />

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
                    ? t(display === 'shapes' ? 'sheet.capoNote' : 'sheet.capoNoteSounding', {
                        capo: option.capo,
                      })
                    : t('sheet.noCapoNote')}
                </p>
              )}
              <SheetView
                lines={lines}
                symbolOfToken={symbolOfToken}
                isChanged={isChanged}
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
                onPick={(choice, id) => setPreference(choice.preferenceKey, id)}
              />
            )}
          </>
        )}
      </main>
      <UpdatePrompt />
    </div>
  )
}
