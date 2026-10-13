import type { Note } from '@barrefree/contracts'
import { assignTab, tabGrid, tabToMusicXml, tabToText } from '@barrefree/theory'
import { lazy, Suspense, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { copyText } from '../lib/clipboard'

// alphaTab is large: load it only when the tab is opened.
const TabView = lazy(() => import('./TabView').then((m) => ({ default: m.TabView })))

interface Props {
  notes: readonly Note[]
  title: string
  /** Capo the chords are shown for; tab frets count from it. */
  capo: number
  /** Transposition in semitones, as on the controls. */
  shift: number
  bpm: number | null
  firstDownbeat: number
  beatsPerBar: number
}

/**
 * Experimental: the transcribed notes as a tab in open position (frets 0-5 above the capo, so
 * no barre is needed). Transcription is imperfect, so this is a starting point to check by ear.
 */
export function TabSection({ notes, title, capo, shift, bpm, firstDownbeat, beatsPerBar }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const tab = useMemo(
    () =>
      assignTab(
        notes.map((n) => ({ start: n.start, end: n.end, midi: n.midi + shift })),
        { capo },
      ),
    [notes, capo, shift],
  )
  const firstNote = tab.notes[0]?.start ?? firstDownbeat
  const grid = useMemo(
    () => tabGrid(bpm && bpm > 0 ? bpm : 100, firstDownbeat, beatsPerBar, firstNote),
    [bpm, firstDownbeat, beatsPerBar, firstNote],
  )
  const musicXml = useMemo(
    () => tabToMusicXml(tab.notes, grid, { title, capo, beatsPerBar }),
    [tab.notes, grid, title, capo, beatsPerBar],
  )

  const copy = async () => {
    if (await copyText(tabToText(tab.notes, grid))) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([musicXml], { type: 'application/vnd.recordare.musicxml+xml' }),
    )
    const link = document.createElement('a')
    link.href = url
    link.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'tab'}.musicxml`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section className="tab-section" aria-labelledby="tab-title">
      <div className="section-head">
        <h2 id="tab-title">{t('tab.title')}</h2>
        <div className="actions">
          <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {open ? t('tab.hide') : t('tab.show')}
          </button>
          <button type="button" onClick={() => void copy()} disabled={tab.notes.length === 0}>
            {copied ? t('actions.copied') : t('tab.copy')}
          </button>
          <button type="button" onClick={download} disabled={tab.notes.length === 0}>
            {t('tab.download')}
          </button>
        </div>
      </div>
      <p className="hint">{t('tab.notice')}</p>
      {capo > 0 && <p className="capo-note">{t('tab.capo', { capo })}</p>}
      {tab.unplayable.length > 0 && (
        <p className="hint">{t('tab.unplayable', { count: tab.unplayable.length })}</p>
      )}
      {open &&
        (tab.notes.length === 0 ? (
          <p className="hint">{t('tab.empty')}</p>
        ) : (
          <Suspense fallback={<p className="hint">{t('tab.rendering')}</p>}>
            <TabView musicXml={musicXml} />
          </Suspense>
        ))}
    </section>
  )
}
