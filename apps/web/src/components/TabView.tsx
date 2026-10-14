import type { AlphaTabApi } from '@coderline/alphatab'
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url'
import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** alphaTab waits for its music font before it starts drawing, and never reports a font that
 * fails to load: without a start within this time, the tab is reported as not drawable. */
const START_TIMEOUT_MS = 15_000

type Status = 'loading' | 'ready' | 'error'

/**
 * Renders a MusicXML tablature with alphaTab (MPL-2.0). alphaTab (about 1 MB) is loaded only
 * when a tab is shown. It runs without web workers (its Vite plugin, which would set them up,
 * is deprecated and missing from the 1.8 package) and without its player: the song page's own
 * player plays the recording. The music font comes from the package through Vite asset URLs.
 *
 * One alphaTab instance lives as long as the view: a new tab (another capo or transposition)
 * is loaded into it. Recreating it per tab leaked every old instance (alphaTab's `destroy`
 * leaves a resize listener on the host element).
 */
export function TabView({ musicXml }: { musicXml: string }) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<AlphaTabApi | null>(null)
  // What is being drawn, and the outcome per tab: a new tab shows "loading" until it is drawn.
  const drawing = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [outcome, setOutcome] = useState<{ xml: string; status: Status } | null>(null)
  const status: Status = outcome?.xml === musicXml ? outcome.status : 'loading'

  const settle = useEffectEvent((status: Status) => {
    clearTimeout(timer.current)
    const xml = drawing.current
    if (xml !== null) setOutcome({ xml, status })
  })
  const show = useEffectEvent(() => {
    const instance = api.current
    if (!instance) return
    drawing.current = musicXml
    clearTimeout(timer.current)
    timer.current = setTimeout(() => settle('error'), START_TIMEOUT_MS)
    if (!instance.load(new TextEncoder().encode(musicXml))) {
      // Reported asynchronously, like every other outcome.
      void Promise.resolve().then(() => settle('error'))
    }
  })

  useEffect(() => {
    let cancelled = false
    import('@coderline/alphatab')
      .then((alphaTab) => {
        if (cancelled || !host.current) return
        const instance = new alphaTab.AlphaTabApi(host.current, {
          core: {
            useWorkers: false,
            enableLazyLoading: false,
            // WOFF2 only: every browser that runs this app reads it.
            smuflFontSources: new Map([['woff2', bravuraWoff2]]),
          },
          display: { staveProfile: 'Tab', scale: 0.9 },
          player: { playerMode: 'Disabled' },
        })
        // Drawing has started, so the font is there: no more time limit.
        instance.renderStarted.on(() => clearTimeout(timer.current))
        instance.renderFinished.on(() => settle('ready'))
        instance.error.on(() => settle('error'))
        api.current = instance
        show()
      })
      .catch(() => {
        if (cancelled) return
        drawing.current = 'unavailable'
        setOutcome({ xml: 'unavailable', status: 'error' })
      })
    return () => {
      cancelled = true
      clearTimeout(timer.current)
      api.current?.destroy()
      api.current = null
    }
  }, [])

  useEffect(() => {
    show()
  }, [musicXml])

  const failed = status === 'error' || outcome?.xml === 'unavailable'
  return (
    <div className="tab-view" aria-busy={status === 'loading' && !failed}>
      {status === 'loading' && !failed && <p className="hint">{t('tab.rendering')}</p>}
      {failed && (
        <p className="warning" role="alert">
          {t('tab.renderFailed')}
        </p>
      )}
      {/* The drawing is for the eyes; the text tab next to it is the readable version. */}
      <div ref={host} className="tab-render" aria-hidden="true" />
    </div>
  )
}
