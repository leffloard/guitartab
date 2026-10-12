import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import en from '../locales/en.json'
import tr from '../locales/tr.json'

export const SUPPORTED_LANGUAGES = ['en', 'tr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

export const resources = {
  en: { translation: en },
  tr: { translation: tr },
} as const

/** Initializes i18next once. Language: ?lng= query, then saved choice, then browser language. */
export function initI18n(): typeof i18n {
  if (!i18n.isInitialized) {
    void i18n
      .use(LanguageDetector)
      .use(initReactI18next)
      .init({
        resources,
        fallbackLng: 'en',
        supportedLngs: SUPPORTED_LANGUAGES,
        nonExplicitSupportedLngs: true,
        interpolation: { escapeValue: false }, // React already escapes
        detection: {
          order: ['querystring', 'localStorage', 'navigator'],
          caches: ['localStorage'],
        },
      })
  }
  return i18n
}
