import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'

import en from '../locales/en.json'
import tr from '../locales/tr.json'

export const SUPPORTED_LANGUAGES = ['en', 'tr'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

/** localStorage key holding the language the user explicitly picked. */
export const LANGUAGE_STORAGE_KEY = 'barrefree.language'

export const resources = {
  en: { translation: en },
  tr: { translation: tr },
} as const

/**
 * Initializes i18next once. Language: `?lng=` query, then the user's explicit choice
 * (saved by {@link setLanguage}), then the browser language. Auto-detected languages are
 * deliberately not cached, so a later change of the browser language still takes effect.
 */
export function initI18n(): typeof i18n {
  if (!i18n.isInitialized) {
    // Registered before init so the initially detected language is applied too.
    i18n.on('languageChanged', () => {
      document.documentElement.lang = i18n.resolvedLanguage ?? 'en'
    })
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
          lookupLocalStorage: LANGUAGE_STORAGE_KEY,
          caches: [],
        },
      })
  }
  return i18n
}

/** Switches the UI language and remembers it as the user's explicit choice. */
export async function setLanguage(lng: SupportedLanguage): Promise<void> {
  await i18n.changeLanguage(lng)
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng)
  } catch {
    // Storage can be unavailable (private mode, blocked site data): the choice is per session then.
  }
}

export function isSupportedLanguage(lng: string): lng is SupportedLanguage {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(lng)
}
