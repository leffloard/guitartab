import { useEffect, useEffectEvent, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { useTranslation } from 'react-i18next'
import WaveSurfer from 'wavesurfer.js'
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js'

import { RATES, formatTime } from '../lib/playback'

export interface PlayerHandle {
  seek: (time: number) => void
  toggle: () => void
  /** The playback position in seconds. */
  time: () => number
}

interface Props {
  /** Object URL of the song's audio. */
  src: string
  onTime: (time: number) => void
  onPlayingChange?: (playing: boolean) => void
  /** Playback speed changes (1 = normal). */
  onRateChange?: (rate: number) => void
  ref?: Ref<PlayerHandle>
}

const SKIP_SEC = 5
const SYMBOLS = { play: '▶', pause: '❚❚', back: '«', forward: '»' } as const

/**
 * Waveform player (wavesurfer.js on an <audio> element): play/pause, seek, slower playback
 * that keeps the pitch (so the chords still match a guitar in tune), and an A-B loop.
 */
export function Player({ src, onTime, onPlayingChange, onRateChange, ref }: Props) {
  const { t } = useTranslation()
  const container = useRef<HTMLDivElement>(null)
  const ws = useRef<WaveSurfer | null>(null)
  const regions = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null)
  const loopRef = useRef<{ a: number; b: number } | null>(null)
  // The wavesurfer listeners live as long as the instance; these always call the latest props.
  const emitTime = useEffectEvent((now: number) => onTime(now))
  const emitPlaying = useEffectEvent((on: boolean) => onPlayingChange?.(on))

  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(1)
  const [pointA, setPointA] = useState<number | null>(null)
  const [loop, setLoop] = useState<{ a: number; b: number } | null>(null)
  const [tooShort, setTooShort] = useState(false)

  useEffect(() => {
    if (!container.current) return
    const media = new Audio()
    media.preservesPitch = true
    const styles = getComputedStyle(document.documentElement)
    const color = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback
    const instance = WaveSurfer.create({
      container: container.current,
      media,
      url: src,
      height: 64,
      waveColor: color('--border', '#33373e'),
      progressColor: color('--accent', '#f0b429'),
      cursorColor: color('--fg', '#eceef1'),
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      dragToSeek: true,
      normalize: true,
    })
    const plugin = instance.registerPlugin(RegionsPlugin.create())
    ws.current = instance
    regions.current = plugin
    let shown = -1
    instance.on('timeupdate', (now) => {
      const range = loopRef.current
      if (range && now >= range.b - 0.02) {
        instance.setTime(range.a)
        return
      }
      emitTime(now)
      // The clock only needs a tenth of a second; avoid re-rendering at frame rate.
      const tenth = Math.floor(now * 10)
      if (tenth !== shown) {
        shown = tenth
        setTime(now)
      }
    })
    instance.on('ready', (d) => setDuration(d))
    instance.on('play', () => {
      setPlaying(true)
      emitPlaying(true)
    })
    instance.on('pause', () => {
      setPlaying(false)
      emitPlaying(false)
    })
    return () => {
      instance.destroy()
      // wavesurfer leaves a media element it did not create alone: stop it, or the song keeps
      // playing after the page is gone.
      media.pause()
      media.removeAttribute('src')
      media.load()
      ws.current = null
      regions.current = null
    }
  }, [src])

  const emitRate = useEffectEvent((r: number) => onRateChange?.(r))
  useEffect(() => {
    ws.current?.setPlaybackRate(rate, true)
    emitRate(rate)
  }, [rate])

  useEffect(() => {
    loopRef.current = loop
    const plugin = regions.current
    if (!plugin) return
    plugin.clearRegions()
    if (loop)
      plugin.addRegion({
        start: loop.a,
        end: loop.b,
        drag: false,
        resize: false,
        color: 'rgba(124, 196, 255, 0.25)',
      })
  }, [loop])

  useImperativeHandle(
    ref,
    () => ({
      seek: (s: number) => ws.current?.setTime(Math.max(0, s)),
      toggle: () => void ws.current?.playPause(),
      time: () => ws.current?.getCurrentTime() ?? 0,
    }),
    [],
  )

  const skip = (delta: number) =>
    ws.current?.setTime(Math.max(0, (ws.current?.getCurrentTime() ?? 0) + delta))
  const markA = () => {
    setPointA(time)
    setLoop(null)
    setTooShort(false)
  }
  const markB = () => {
    // B may come before A: the loop is the span between the two points.
    if (pointA === null) return
    const far = Math.abs(time - pointA) > 0.5
    setTooShort(!far)
    if (far) setLoop({ a: Math.min(pointA, time), b: Math.max(pointA, time) })
  }

  return (
    <section className="player" aria-label={t('player.label')}>
      <div ref={container} className="waveform" />
      <div className="player-row">
        <button
          type="button"
          aria-label={t('player.back', { sec: SKIP_SEC })}
          onClick={() => skip(-SKIP_SEC)}
        >
          {SYMBOLS.back}
        </button>
        <button
          type="button"
          className="primary play"
          aria-label={playing ? t('player.pause') : t('player.play')}
          onClick={() => void ws.current?.playPause()}
        >
          {playing ? SYMBOLS.pause : SYMBOLS.play}
        </button>
        <button
          type="button"
          aria-label={t('player.forward', { sec: SKIP_SEC })}
          onClick={() => skip(SKIP_SEC)}
        >
          {SYMBOLS.forward}
        </button>
        <span className="clock">
          {t('player.time', { time: formatTime(time), duration: formatTime(duration) })}
        </span>
      </div>
      <div className="player-row">
        <label className="field">
          {t('player.speed')}
          <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {t('player.rate', { percent: Math.round(r * 100) })}
              </option>
            ))}
          </select>
        </label>
        <div className="loop" role="group" aria-label={t('player.loop')}>
          <button type="button" aria-pressed={pointA !== null && !loop} onClick={markA}>
            {t('player.setA')}
          </button>
          <button
            type="button"
            disabled={pointA === null}
            aria-pressed={loop !== null}
            onClick={markB}
          >
            {t('player.setB')}
          </button>
          {(loop || pointA !== null) && (
            <button
              type="button"
              onClick={() => {
                setLoop(null)
                setPointA(null)
                setTooShort(false)
              }}
            >
              {t('player.clearLoop')}
            </button>
          )}
        </div>
      </div>
      {tooShort && !loop && (
        <p className="hint" role="status">
          {t('player.loopTooShort')}
        </p>
      )}
      {loop && (
        <p className="hint">
          {t('player.looping', { a: formatTime(loop.a), b: formatTime(loop.b) })}
        </p>
      )}
    </section>
  )
}
