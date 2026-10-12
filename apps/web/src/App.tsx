import { useTranslation } from 'react-i18next'

import { isSupportedLanguage, setLanguage, SUPPORTED_LANGUAGES } from './i18n'

export function App() {
  const { t, i18n } = useTranslation()

  return (
    <main className="app">
      <header>
        <h1>{t('app.title')}</h1>
        <label>
          {t('language.label')}{' '}
          <select
            value={i18n.resolvedLanguage}
            onChange={(e) => {
              if (isSupportedLanguage(e.target.value)) void setLanguage(e.target.value)
            }}
          >
            {SUPPORTED_LANGUAGES.map((lng) => (
              <option key={lng} value={lng}>
                {t(`language.${lng}`)}
              </option>
            ))}
          </select>
        </label>
      </header>
      <p>{t('app.tagline')}</p>
      <p>{t('app.status')}</p>
    </main>
  )
}
