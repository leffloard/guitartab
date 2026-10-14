import type { Note } from '@barrefree/contracts'
import {
  assignTab,
  beatGrid,
  placeOnGrid,
  tabGrid,
  tabToMusicXml,
  tabToText,
} from '@barrefree/theory'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { copyText } from '../lib/clipboard'
import { TabView } from './TabView'

interface Props {
  notes: readonly Note[]
  title: string
  /** Capo the chords are shown for; tab frets count from it. */
  capo: number
  /** Transposition in semitones, as on the controls. */
  shift: number
  /** Detected beats and downbeats: the written tab follows them. */
  beats: readonly number[]
  downbeats: readonly number[]
  /** Fallback when there are too few beats. */
  bpm: number | null
  beatsPerBar: number
}

/**
 * Experimental: the transcribed notes as a tab in open position (frets 0-5 above the capo, so
 * no barre is needed). Transcription is imperfect, so this is a starting point to check by ear.
 */
export function TabSection({
  notes,
  title,
  capo,
  shift,
  beats,
  downbeats,
  bpm,
  beatsPerBar,
}: Props) {
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
  const firstNote = tab.notes[0]?.start
  const grid = useMemo(
    () =>
      beatGrid(beats, downbeats, beatsPerBar, firstNote) ??
      tabGrid(bpm && bpm > 0 ? bpm : 100, downbeats[0] ?? 0, beatsPerBar, firstNote),
    [beats, downbeats, bpm, beatsPerBar, firstNote],
  )
  const crowded = useMemo(() => placeOnGrid(tab.notes, grid).crowded.length, [tab.notes, grid])
  const musicXml = useMemo(
    () => tabToMusicXml(tab.notes, grid, { title, capo, beatsPerBar }),
    [tab.notes, grid, title, capo, beatsPerBar],
  )

  // Frets count from the capo: the text says so, as the chord chart's copy does.
  const text = useMemo(() => {
    const header = [title, capo > 0 ? t('export.capoHeader', { capo }) : null]
    return [...header.filter(Boolean), '', tabToText(tab.notes, grid)].join('\n')
  }, [title, capo, t, tab.notes, grid])

  const copy = async () => {
    if (await copyText(text)) {
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
      {crowded > 0 && <p className="hint">{t('tab.crowded', { count: crowded })}</p>}
      {open &&
        (tab.notes.length === 0 ? (
          <p className="hint">{t('tab.empty')}</p>
        ) : (
          <>
            {/* alphaTab itself is loaded only now, by TabView. */}
            <TabView musicXml={musicXml} />
            {/* The drawing is hidden from screen readers; this is the readable tab. */}
            <pre className="visually-hidden">{text}</pre>
          </>
        ))}
    </section>
  )
}
