import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { TabSection } from './TabSection'

// alphaTab needs a real browser (fonts, canvas/SVG layout); it is checked in Chromium.
vi.mock('./TabView', () => ({
  TabView: ({ musicXml }: { musicXml: string }) => <pre data-testid="tab-view">{musicXml}</pre>,
}))

const beats = Array.from({ length: 12 }, (_, i) => 0.5 + i * 0.6)
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
        beats={beats}
        downbeats={[0.5]}
        bpm={100}
        beatsPerBar={4}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Tab (experimental)' })).toBeInTheDocument()
    // MIDI 30 is below the low E string.
    expect(screen.getByText(/1 note is out of reach/)).toBeInTheDocument()
    expect(screen.queryByTestId('tab-view')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Show tab' }))
    expect(await screen.findByTestId('tab-view')).toHaveTextContent('<score-partwise')
    await userEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
    const text = (writeText.mock.calls[0] as unknown as [string])[0]
    // The C shape: A string fret 3, D 2, G 0, B 1, e 0.
    expect(text).toMatch(/^Song\n\ne\|/)
    expect(text).toContain('3')
  })

  it('counts frets from the capo it is given', () => {
    render(
      <TabSection
        notes={notes}
        title="Song"
        capo={3}
        shift={0}
        beats={beats}
        downbeats={[0.5]}
        bpm={100}
        beatsPerBar={4}
      />,
    )
    expect(screen.getByText(/Capo on fret 3/)).toBeInTheDocument()
  })

  it('hands alphaTab a MusicXML tab with the capo, frets counted from it', async () => {
    render(
      <TabSection
        notes={notes}
        title="Song"
        capo={3}
        shift={0}
        beats={beats}
        downbeats={[0.5]}
        bpm={100}
        beatsPerBar={4}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Show tab' }))
    const xml = (await screen.findByTestId('tab-view')).textContent ?? ''
    expect(xml).toContain('<capo>3</capo>')
    // C3 (MIDI 48) with the capo on 3 is the A string, fret 0: <string>5</string><fret>0</fret>.
    expect(xml).toContain('<octave>3</octave></pitch>')
    expect(xml).toMatch(/<step>C<\/step><octave>3<\/octave>.*?<string>5<\/string><fret>0<\/fret>/)
  })

  it('writes the same frets for a transposed song with the matching capo', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    Object.assign(navigator, { clipboard: { writeText } })
    const copied = async (capo: number, shift: number) => {
      const view = render(
        <TabSection
          notes={notes}
          title="Song"
          capo={capo}
          shift={shift}
          beats={beats}
          downbeats={[0.5]}
          bpm={100}
          beatsPerBar={4}
        />,
      )
      await userEvent.click(screen.getByRole('button', { name: 'Copy as text' }))
      view.unmount()
      return (writeText.mock.calls.at(-1) as unknown as [string])[0]
    }
    const plain = await copied(0, 0)
    // Two semitones up with the capo on 2: same shapes, and the text says where the capo goes.
    const capoed = await copied(2, 2)
    expect(capoed.startsWith('Song\nCapo: 2\n\n')).toBe(true)
    expect(plain.startsWith('Song\n\n')).toBe(true)
    expect(capoed.split('\n').slice(3)).toEqual(plain.split('\n').slice(2))
  })

  it('says when notes are too close together to write', () => {
    // A fast trill on the D string, 40 ms a note: faster than the sixteenth grid (150 ms).
    const run = [50, 52, 50, 52, 50, 52].map((midi, i) => ({
      start: 0.5 + i * 0.04,
      end: 0.54 + i * 0.04,
      midi,
      velocity: 0.8,
    }))
    render(
      <TabSection
        notes={run}
        title="Song"
        capo={0}
        shift={0}
        beats={beats}
        downbeats={[0.5]}
        bpm={100}
        beatsPerBar={4}
      />,
    )
    expect(screen.getByText(/notes? (is|are) too close to the one before/)).toBeInTheDocument()
  })
})
