import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it } from 'vitest'

import { App } from './App'
import { LANGUAGE_STORAGE_KEY } from './i18n'

describe('App', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the English tagline', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'BarreFree' })).toBeInTheDocument()
    expect(screen.getByText(/barre-free acoustic guitar chords/i)).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('en')
  })

  it('switches to Turkish, updates <html lang> and remembers the explicit choice', async () => {
    render(<App />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'tr')
    expect(await screen.findByText(/barresiz akustik gitar akorlarına/i)).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('tr')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('tr')
  })

  it('does not persist a language that was not explicitly chosen', async () => {
    await i18n.changeLanguage('tr')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
  })
})
