import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it } from 'vitest'

import { App } from './App'

describe('App', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the English tagline', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'BarreFree' })).toBeInTheDocument()
    expect(screen.getByText(/barre-free acoustic guitar chords/i)).toBeInTheDocument()
  })

  it('switches to Turkish', async () => {
    render(<App />)
    await userEvent.selectOptions(screen.getByRole('combobox'), 'tr')
    expect(await screen.findByText(/barresiz akustik gitar akorlarına/i)).toBeInTheDocument()
  })
})
