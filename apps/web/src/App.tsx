import type { Health } from '@barrefree/contracts'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Link } from './components/Link'
import { SettingsPanel } from './components/SettingsPanel'
import { UpdatePrompt } from './components/UpdatePrompt'
import { useSettings } from './hooks/useSettings'
import { fetchHealth } from './lib/api'
import { usePathname, useRoute } from './lib/router'
import { HomePage } from './pages/HomePage'
import { JobPage } from './pages/JobPage'
import { LibraryPage } from './pages/LibraryPage'
import { SongPage } from './pages/SongPage'

export function App() {
  const { t } = useTranslation()
  const [settings, updateSettings] = useSettings()
  const route = useRoute()
  const pathname = usePathname()
  const main = useRef<HTMLElement>(null)
  const firstPage = useRef(true)
  const [health, setHealth] = useState<Health | null>(null)
  const [healthLoaded, setHealthLoaded] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    void fetchHealth(controller.signal).then((h) => {
      if (controller.signal.aborted) return
      setHealth(h)
      setHealthLoaded(true)
    })
    return () => controller.abort()
  }, [])

  // A new page: name it in the title (the song page names itself) and move focus to it, so a
  // screen reader announces it instead of staying on a link that no longer exists.
  useEffect(() => {
    const page =
      route.name === 'library'
        ? t('nav.library')
        : route.name === 'job'
          ? t('job.title')
          : route.name === 'not-found'
            ? t('nav.notFound')
            : null
    // The song page names itself once the song is loaded.
    document.title = page ? `${page} · ${t('app.title')}` : t('app.title')
  }, [route.name, t])
  useEffect(() => {
    if (firstPage.current) {
      firstPage.current = false
      return
    }
    const heading = main.current?.querySelector<HTMLElement>('h2')
    const target = heading ?? main.current
    if (!target) return
    target.tabIndex = -1
    target.focus({ preventScroll: true })
  }, [pathname])

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1>
            <Link href="/" className="home-link">
              {t('app.title')}
            </Link>
          </h1>
          <p className="tagline">{t('app.tagline')}</p>
        </div>
        <nav className="nav" aria-label={t('nav.label')}>
          <Link href="/library" aria-current={route.name === 'library' ? 'page' : undefined}>
            {t('nav.library')}
          </Link>
          <SettingsPanel settings={settings} onChange={updateSettings} />
        </nav>
      </header>

      <main ref={main} className={`layout layout-${route.name}`}>
        {route.name === 'home' && (
          <HomePage settings={settings} health={health} healthLoaded={healthLoaded} />
        )}
        {route.name === 'library' && <LibraryPage />}
        {route.name === 'job' && <JobPage key={route.id} id={route.id} />}
        {route.name === 'song' && <SongPage key={route.id} id={route.id} settings={settings} />}
        {route.name === 'not-found' && (
          <section>
            <p>{t('nav.notFound')}</p>
            <Link href="/">{t('nav.home')}</Link>
          </section>
        )}
      </main>
      <footer className="app-footer">
        <a href="/third-party/NOTICE.txt">{t('footer.licenses')}</a>
      </footer>
      <UpdatePrompt />
    </div>
  )
}
