import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabSection } from './TabSection'

// alphaTab needs a real browser (fonts, canvas/SVG layout); it is checked in Chromium.
vi.mock('./TabView', () => ({
  TabView: ({ musicXml }: { musicXml: string }) => (
    <pre data-testid="tab-view">{musicXml.length > 0 ? 'xml' : ''}</pre>
  ),
}))

const notes = [48, 52, 55, 60, 64, 30].map((midi, i) => ({
  start: 0.5 + i * 0.3,
  end: 0.8 + i * 0.3,
  midi,
  velocity: 0.8,
}))

describe('tab section', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('opens the tab on request, says what is left out and copies text tab', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    render(
      <TabSection
        notes={notes}
        title="Song"
        capo={0}
        shift={0}
        bpm={100}
        firstDownbeat={0.5}
        beatsPerBar={4}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Tab (experimental)' })).toBeInTheDocument()
    // MIDI 30 is below the low E string.
    expect(screen.getByText(/1 note is out of reach/)).toBeInTheDocument()
    expect(screen.queryByTestId('tab-view')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show tab' }))
    expect(await screen.findByTestId('tab-view')).toHaveTextContent('xml')
    await userEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    const text = (writeText.mock.calls[0] as unknown as [string])[0]
    // The C shape: A string fret 3, D 2, G 0, B 1, e 0.
    expect(text).toMatch(/^e\|/)
    expect(text).toContain('3')
  })

  it('counts frets from the capo it is given', () => {
    render(
      <TabSection
        notes={notes}
        title="Song"
        capo={3}
        shift={0}
        bpm={100}
        firstDownbeat={0.5}
        beatsPerBar={4}
      />,
    )
    expect(screen.getByText(/Capo on fret 3/)).toBeInTheDocument()
  })
})
