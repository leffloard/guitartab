import { useTranslation } from 'react-i18next'

import type { NoteNames, Settings } from '../hooks/useSettings'
import { isSupportedLanguage, setLanguage, SUPPORTED_LANGUAGES } from '../i18n'

interface Props {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

export function SettingsPanel({ settings, onChange }: Props) {
  const { t, i18n } = useTranslation()
  return (
    <details className="settings">
      <summary>{t('settings.title')}</summary>
      <label>
        {t('language.label')}
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
      <label>
        {t('settings.noteNames')}
        <select
          value={settings.noteNames}
          onChange={(e) => onChange({ noteNames: e.target.value as NoteNames })}
        >
          <option value="letter">{t('settings.letters')}</option>
          <option value="solfege">{t('settings.solfege')}</option>
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.keepScreenOn}
          onChange={(e) => onChange({ keepScreenOn: e.target.checked })}
        />
        {t('settings.keepScreenOn')}
      </label>
    </details>
  )
}
