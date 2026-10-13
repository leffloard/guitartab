import type { AlphaTabApi } from '@coderline/alphatab'
import bravuraWoff2 from '@coderline/alphatab/font/Bravura.woff2?url'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

/**
 * Renders a MusicXML tablature with alphaTab (MPL-2.0). alphaTab (about 1 MB) is loaded only
 * when a tab is shown. It runs without web workers (its Vite plugin, which would set them up,
 * is deprecated and missing from the 1.8 package) and without its player: the song page's own
 * player plays the recording. The music font comes from the package through Vite asset URLs.
 */
export function TabView({ musicXml }: { musicXml: string }) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let api: AlphaTabApi | null = null
    let cancelled = false
    import('@coderline/alphatab')
      .then((alphaTab) => {
        if (cancelled || !host.current) return
        api = new alphaTab.AlphaTabApi(host.current, {
          core: {
            useWorkers: false,
            enableLazyLoading: false,
            // WOFF2 only: every browser that runs this app reads it.
            smuflFontSources: new Map([['woff2', bravuraWoff2]]),
          },
          display: { staveProfile: 'Tab', scale: 0.9 },
          player: { playerMode: 'Disabled' },
        })
        api.renderFinished.on(() => setState('ready'))
        api.error.on(() => setState('error'))
        if (!api.load(new TextEncoder().encode(musicXml))) setState('error')
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
      api?.destroy()
    }
  }, [musicXml])

  return (
    <div className="tab-view" aria-busy={state === 'loading'}>
      {state === 'loading' && <p className="hint">{t('tab.rendering')}</p>}
      {state === 'error' && (
        <p className="warning" role="alert">
          {t('tab.renderFailed')}
        </p>
      )}
      <div ref={host} className="tab-render" />
    </div>
  )
}
