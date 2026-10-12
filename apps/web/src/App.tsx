import {
  chordKey,
  LAMBDA_STOPS,
  parseChordSheet,
  renderChordSheet,
  renderedToText,
  sheetProgression,
  simplify,
  spellPitchClass,
  toChordPro,
  transform,
  MODE_PRESETS,
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
  const [capo, setCapo] = useState<number | null>(null)
  const [shift, setShift] = useState(0)
  const [display, setDisplay] = useState<ChordDisplay>('shapes')
  const [selected, setSelected] = useState<string | null>(null)
  const [copied, setCopied] = useState<'text' | 'chordpro' | null>(null)

  const setText = useCallback((value: string) => {
    setTextState(value)
    setCapo(null)
    writeStored(DRAFT_KEY, value === '' ? undefined : value)
  }, [])

  const deferredText = useDeferredValue(text)
  const sheet = useMemo(() => parseChordSheet(deferredText), [deferredText])
  const lambda = LAMBDA_STOPS[lambdaIndex] ?? 10
  const result = useMemo(
    () =>
      transform(sheetProgression(sheet), {
        mode,
        lambda,
        transpose: shift,
        ...(noCapo ? { capoRange: [0, 0] as const } : {}),
        ...(capo === null ? {} : { capo }),
      }),
    [sheet, mode, lambda, shift, noCapo, capo],
  )
  const choices = useMemo(
    () => effectiveChoices(result, lambda, preferences),
    [result, lambda, preferences],
  )
  useWakeLock(settings.keepScreenOn && sheet.chords.length > 0)

  const names = { display, noteNames: settings.noteNames } as const
  const choiceOfToken = (token: ChordToken): EffectiveChoice | undefined => {
    const item = result.items[token.index]
    if (!item?.input) return undefined
    return choices.get(chordKey(simplify(item.input, MODE_PRESETS[mode].simplify)))
  }
  const replace = (token: ChordToken) => {
    const choice = choiceOfToken(token)
    return choice ? choiceName(choice, result, names) : token.text
  }
  const lines = renderChordSheet(sheet, replace)
  const substituted = new Set(
    [...choices.entries()].filter(([, c]) => c.substituted).map(([key]) => key),
  )
  const symbolOfToken = (index: number) => {
    const token = sheet.chords[index]
    const choice = token && choiceOfToken(token)
    return choice ? chordKey(choice.chord) : null
  }

  const option = result.option
  const keyLabel =
    sheet.chords.length > 0
      ? keyName(
          display === 'shapes' && option && option.capo > 0 ? result.key.shape : result.key.input,
          (pc) =>
            spellPitchClass(
              pc,
              display === 'shapes' && option && option.capo > 0
                ? result.spelling.shape
                : result.spelling.input,
            ),
        )
      : null

  const copy = async (kind: 'text' | 'chordpro') => {
    const content =
      kind === 'text'
        ? renderedToText(lines)
        : toChordPro(sheet, replace, option && option.capo > 0 ? { capo: option.capo } : {})
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
              onMode={(m) => {
                setMode(m)
                setCapo(null)
              }}
              lambdaIndex={lambdaIndex}
              onLambdaIndex={setLambdaIndex}
              alternatives={result.alternatives}
              capo={capo}
              onCapo={setCapo}
              noCapo={noCapo}
              onNoCapo={(v) => {
                setNoCapo(v)
                setCapo(null)
              }}
              transpose={shift}
              onTranspose={(v) => {
                setShift(Math.max(-11, Math.min(11, v)))
                setCapo(null)
              }}
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
                  {option.capo > 0
                    ? t('sheet.capoNote', { capo: option.capo })
                    : t('sheet.noCapoNote')}
                </p>
              )}
              <SheetView
                lines={lines}
                symbolOfToken={symbolOfToken}
                substitutedSymbols={substituted}
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
