import {
  barsFromBeats,
  beatsBetween,
  chartToChordPro,
  chartToText,
  chordIndexAt,
  layoutBars,
  nextChordIndex,
  trimEmptyBars,
  type TimedChord,
} from '@barrefree/theory'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ChordChart } from '../components/ChordChart'
import { ChordStrip } from '../components/ChordStrip'
import { Controls } from '../components/Controls'
import { DiagramList } from '../components/DiagramList'
import { EditChordDialog } from '../components/EditChordDialog'
import { Link } from '../components/Link'
import { Player, type PlayerHandle } from '../components/Player'
import { TabSection } from '../components/TabSection'
import { useArrangement, type ArrangementView } from '../hooks/useArrangement'
import type { Settings } from '../hooks/useSettings'
import { useWakeLock } from '../hooks/useWakeLock'
import { copyText } from '../lib/clipboard'
import { labelFromFrame, labelInFrame, type Frame } from '../lib/edits'
import { getAudio, getSong, updateSong, type SongRecord } from '../lib/library'
import { strumPattern } from '../lib/strum'

/** Chords the analyzer is less sure of than this are marked for checking. */
export const UNCERTAIN_BELOW = 0.5

interface Position {
  index: number
  next: number
  beats: number | null
  seconds: number | null
  bar: number
}

/** Where `time` falls: the chord and bar playing, the next change and how far away it is. */
function positionAt(
  chords: readonly TimedChord[],
  bars: readonly { start: number; end: number }[],
  beatTimes: readonly number[],
  time: number,
): Position {
  const index = chordIndexAt(chords, time)
  const next = nextChordIndex(chords, time)
  const nextStart = next >= 0 ? (chords[next]?.start ?? null) : null
  const counted =
    nextStart !== null && beatTimes.length > 1 ? beatsBetween(beatTimes, time, nextStart) : 0
  // Count beats (re-rendering only when the beat changes). Without a beat grid, or when the
  // change is off the grid and less than a beat away, count seconds to a tenth instead.
  const beats = counted > 0 ? counted : null
  const seconds =
    nextStart !== null && beats === null ? Math.round((nextStart - time) * 10) / 10 : null
  return { index, next, beats, seconds, bar: chordIndexAt(bars, time) }
}

/** A stored fix as the dialog's starting text, in the chart's frame (letter names, to edit). */
function editValue(label: string | undefined, frame: Frame): string | null {
  return label === undefined ? null : labelInFrame(label, frame)
}

const samePosition = (a: Position, b: Position) =>
  a.index === b.index &&
  a.next === b.next &&
  a.beats === b.beats &&
  a.seconds === b.seconds &&
  a.bar === b.bar

/** Loads a song from the library (analysis + audio) and shows the play-along view. */
export function SongPage({ id, settings }: { id: string; settings: Settings }) {
  const { t } = useTranslation()
  const [song, setSong] = useState<SongRecord | null | undefined>(undefined)
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    Promise.all([getSong(id), getAudio(id)]).then(
      ([record, audio]) => {
        if (cancelled) return
        setSong(record ?? null)
        if (audio) {
          url = URL.createObjectURL(audio)
          setAudioUrl(url)
        }
      },
      () => {
        if (!cancelled) setUnavailable(true)
      },
    )
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [id])

  if (unavailable)
    return (
      <p className="warning" role="alert">
        {t('library.unavailable')}
      </p>
    )
  if (song === undefined) return <p className="hint">{t('song.loading')}</p>
  if (song === null)
    return (
      <section>
        <p className="warning">{t('song.missing')}</p>
        <Link href="/library">{t('nav.library')}</Link>
      </section>
    )
  return <SongView song={song} audioUrl={audioUrl} settings={settings} onChange={setSong} />
}

function SongView({
  song,
  audioUrl,
  settings,
  onChange,
}: {
  song: SongRecord
  audioUrl: string | null
  settings: Settings
  onChange: (song: SongRecord) => void
}) {
  const { t } = useTranslation()
  const { analysis } = song
  useEffect(() => {
    document.title = `${song.title} · ${t('app.title')}`
  }, [song.title, t])
  const player = useRef<PlayerHandle>(null)
  const [playing, setPlaying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editIndex, setEditIndex] = useState<number | null>(null)
  const [copied, setCopied] = useState<'text' | 'chordpro' | null>(null)
  const [rate, setRate] = useState(1)

  const chords: TimedChord[] = useMemo(
    () =>
      analysis.chords.map((c, i) => ({
        start: c.start,
        end: c.end,
        label: song.edits[i] ?? c.label,
        confidence: c.confidence,
      })),
    [analysis, song.edits],
  )
  const progression = useMemo(
    () => chords.map((c) => ({ label: c.label, start: c.start, end: c.end })),
    [chords],
  )
  // The song is the identity: a capo pick holds while chords are being fixed.
  const arrangement = useArrangement(progression, song.id, {
    noteNames: settings.noteNames,
    initial: song.view,
  })
  const { result, choices, names, option, capoOn, shapesShown, view, frame } = arrangement

  // Keep the controls' state with the song: debounced, and flushed when leaving the page.
  const viewKey = JSON.stringify(view)
  const unsavedView = useRef<string | null>(null)
  useEffect(() => {
    unsavedView.current = viewKey
    const timer = setTimeout(() => {
      unsavedView.current = null
      void updateSong(song.id, { view: JSON.parse(viewKey) as ArrangementView })
    }, 400)
    return () => clearTimeout(timer)
  }, [song.id, viewKey])
  useEffect(() => {
    const flush = () => {
      const pending = unsavedView.current
      unsavedView.current = null
      if (pending) void updateSong(song.id, { view: JSON.parse(pending) as ArrangementView })
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [song.id])

  const beatsPerBar = Number.parseInt(analysis.timeSignature ?? '4', 10) || 4
  const bars = useMemo(
    () =>
      trimEmptyBars(
        layoutBars(
          barsFromBeats(analysis.beats, analysis.downbeats, analysis.durationSec, beatsPerBar),
          chords,
          { beatsPerBar },
        ),
        (index) => song.edits[index] !== undefined,
      ),
    [analysis, chords, beatsPerBar, song.edits],
  )

  // Before the first time update the player is at 0 s: show the first chord and the countdown.
  const [pos, setPos] = useState<Position>(() => positionAt(chords, bars, analysis.beats, 0))
  const onTime = useCallback(
    (time: number) => {
      const now = positionAt(chords, bars, analysis.beats, time)
      setPos((p) => (samePosition(p, now) ? p : now))
    },
    [chords, bars, analysis.beats],
  )
  // A fix changes the chords while the player may be paused (no time updates): re-place.
  useEffect(() => {
    onTime(player.current?.time() ?? 0)
  }, [onTime])

  useWakeLock(settings.keepScreenOn && playing)
  useEffect(() => {
    if (!playing || pos.bar < 0) return
    document
      .querySelector('.chart .bar.is-current')
      ?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })
  }, [playing, pos.bar])

  const nameOf = (index: number) => arrangement.nameOf(index)
  const uncertain = chords.filter(
    (c, i) =>
      song.edits[i] === undefined && c.label !== 'N' && (c.confidence ?? 1) < UNCERTAIN_BELOW,
  ).length
  const current = pos.index >= 0 ? chords[pos.index] : undefined

  /** Saves what the user typed (read in the chart's frame); null or the heard chord: no fix. */
  const saveEdit = (index: number, text: string | null) => {
    const label = text === null ? null : labelFromFrame(text, frame)
    const heard = analysis.chords[index]?.label ?? ''
    const edits = { ...song.edits }
    if (label === null || label === labelFromFrame(heard, { ...frame, offset: 0 })) {
      delete edits[index]
    } else edits[index] = label
    const next = { ...song, edits }
    onChange(next)
    void updateSong(song.id, { edits })
    setEditIndex(null)
  }

  const exportChart = async (kind: 'text' | 'chordpro') => {
    const capoForCopy = shapesShown && option ? option.capo : 0
    const name = (i: number) => nameOf(i) ?? chords[i]?.label ?? '?'
    const content =
      kind === 'text'
        ? [
            song.title,
            capoForCopy > 0 ? t('export.capoHeader', { capo: capoForCopy }) : null,
            '',
            chartToText(bars, name, { beatsPerBar }),
          ]
            .filter((l) => l !== null)
            .join('\n') + '\n'
        : chartToChordPro(
            bars,
            name,
            {
              title: song.title,
              ...(capoForCopy > 0 ? { capo: capoForCopy } : {}),
              ...(analysis.tempoBpm ? { tempo: analysis.tempoBpm } : {}),
              ...(analysis.timeSignature ? { time: analysis.timeSignature } : {}),
            },
            { beatsPerBar },
          )
    if (await copyText(content)) {
      setCopied(kind)
      setTimeout(() => setCopied(null), 1500)
    }
  }

  const selected = pos.index >= 0 ? arrangement.symbolOf(pos.index) : null

  return (
    <>
      <section className="song-head" aria-labelledby="song-title">
        <h2 id="song-title">{song.title}</h2>
        <p className="song-facts">
          {analysis.tempoBpm ? (
            <span>{t('song.tempo', { bpm: Math.round(analysis.tempoBpm) })}</span>
          ) : null}
          {analysis.timeSignature ? (
            <span>{t('song.meter', { meter: analysis.timeSignature })}</span>
          ) : null}
          <span>
            {t('song.strum', { pattern: strumPattern(analysis.timeSignature, analysis.tempoBpm) })}
          </span>
        </p>
        <p className="hint">{t('song.strumHint')}</p>
      </section>

      {audioUrl ? (
        <Player
          ref={player}
          src={audioUrl}
          onTime={onTime}
          onPlayingChange={setPlaying}
          onRateChange={setRate}
        />
      ) : (
        <p className="warning">{t('song.noAudio')}</p>
      )}

      <ChordStrip
        current={current ? (nameOf(pos.index) ?? null) : null}
        next={pos.next >= 0 ? nameOf(pos.next) : null}
        beats={pos.beats}
        // Seconds of music; at a slower speed they take longer to arrive.
        seconds={pos.seconds === null ? null : Math.round((pos.seconds / rate) * 10) / 10}
        uncertain={
          pos.index >= 0 &&
          song.edits[pos.index] === undefined &&
          (current?.confidence ?? 1) < UNCERTAIN_BELOW
        }
      />

      <Controls {...arrangement.controls} keyName={arrangement.keyLabel} />

      <section className="result" aria-labelledby="chart-title">
        <div className="section-head">
          <h2 id="chart-title">{t('chart.title')}</h2>
          <div className="actions">
            <button type="button" aria-pressed={editing} onClick={() => setEditing((e) => !e)}>
              {editing ? t('chart.doneEditing') : t('chart.edit')}
            </button>
            <button type="button" onClick={() => void exportChart('text')}>
              {copied === 'text' ? t('actions.copied') : t('actions.copyText')}
            </button>
            <button type="button" onClick={() => void exportChart('chordpro')}>
              {copied === 'chordpro' ? t('actions.copied') : t('actions.copyChordPro')}
            </button>
            <button type="button" onClick={() => window.print()}>
              {t('actions.print')}
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
        {uncertain > 0 && <p className="hint">{t('chart.uncertainCount', { count: uncertain })}</p>}
        {editing && <p className="hint">{t('chart.editHint')}</p>}
        <ChordChart
          bars={bars}
          chords={chords}
          nameOf={nameOf}
          currentBar={pos.bar}
          currentChord={pos.index}
          threshold={UNCERTAIN_BELOW}
          isEdited={(i) => song.edits[i] !== undefined}
          isChanged={arrangement.isChanged}
          editing={editing}
          onSeek={(i) => player.current?.seek(chords[i]?.start ?? 0)}
          onEdit={setEditIndex}
        />
      </section>

      {analysis.notes.length > 0 && (
        <TabSection
          notes={analysis.notes}
          title={song.title}
          capo={capoOn && option ? option.capo : 0}
          shift={view.shift}
          bpm={analysis.tempoBpm ?? null}
          firstDownbeat={analysis.downbeats[0] ?? analysis.beats[0] ?? 0}
          beatsPerBar={beatsPerBar}
        />
      )}

      {option && (
        <DiagramList
          choices={[...choices.values()]}
          result={result}
          names={names}
          selected={selected}
          scrollToSelected={!playing}
          onPick={arrangement.pickVoicing}
        />
      )}

      {editIndex !== null && (
        <EditChordDialog
          detected={labelInFrame(
            analysis.chords[editIndex]?.label ?? 'N',
            frame,
            settings.noteNames,
          )}
          value={editValue(song.edits[editIndex], frame)}
          shifted={frame.offset !== 0}
          onSave={(label) => saveEdit(editIndex, label)}
          onClose={() => setEditIndex(null)}
        />
      )}
    </>
  )
}
