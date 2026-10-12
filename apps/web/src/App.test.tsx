import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from './App'
import { LANGUAGE_STORAGE_KEY } from './i18n'

const SONG = `F        C          G         Am
One two three four five six seven
Bm       G          D         A
Eight nine ten eleven twelve
`

function sheetText() {
  return screen.getByLabelText('Chord sheet').textContent ?? ''
}

async function paste(text: string) {
  const box = screen.getByRole('textbox', { name: 'Paste chords' })
  // fireEvent.change sets the whole value at once (typing it would be slow and parse brackets).
  fireEvent.change(box, { target: { value: text } })
  // The sheet is derived through useDeferredValue: let React flush it.
  await act(async () => {
    await Promise.resolve()
  })
}

describe('App', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders the English tagline and no result before any chords', () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'BarreFree' })).toBeInTheDocument()
    expect(screen.getByText(/barre-free acoustic guitar chords/i)).toBeInTheDocument()
    expect(screen.getByText('No chords found yet.')).toBeInTheDocument()
    expect(screen.queryByLabelText('Chord sheet')).not.toBeInTheDocument()
    expect(document.documentElement.lang).toBe('en')
  })

  it('switches to Turkish, updates <html lang> and remembers the explicit choice', async () => {
    render(<App />)
    await userEvent.click(screen.getByText('Settings'))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Language' }), 'tr')
    expect(await screen.findByText(/barresiz akustik gitar akorlarına/i)).toBeInTheDocument()
    expect(document.documentElement.lang).toBe('tr')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('tr')
  })

  it('does not persist a language that was not explicitly chosen', async () => {
    await i18n.changeLanguage('tr')
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull()
  })

  it('turns a pasted sheet barre-free and keeps the columns (easy mode)', async () => {
    render(<App />)
    await paste(SONG)
    expect(screen.getByText(/8 chords found/)).toBeInTheDocument()
    const text = sheetText()
    expect(text).toContain('Fmaj7    C          G         Am\nOne two three four five six seven')
    expect(text).toContain('Bm7      G          D         A\nEight nine ten eleven twelve')
    expect(screen.getByText('No capo needed.')).toBeInTheDocument()
    // Substitutes are marked in the sheet and get a diagram card.
    expect(screen.getAllByRole('button', { name: 'Fmaj7' })[0]).toHaveClass('is-substituted')
    expect(
      screen.getByRole('img', { name: 'Chord diagram for Fmaj7: x x 3 2 1 0 (low E to high E)' }),
    ).toBeInTheDocument()
    expect(screen.getByText('for F')).toBeInTheDocument()
  })

  it('switches modes instantly: original keeps F and Bm, capo mode moves the capo', async () => {
    render(<App />)
    await paste('F  C  G  Am\n')
    await userEvent.click(screen.getByRole('radio', { name: 'Original' }))
    expect(sheetText()).toContain('F  C  G  Am')
    await userEvent.click(screen.getByRole('radio', { name: 'Capo' }))
    expect(screen.getByText(/Put the capo on fret 5/)).toBeInTheDocument()
    expect(sheetText()).toContain('C  G  D  Em')
    // Show what it sounds like instead of the shapes.
    await userEvent.click(screen.getByRole('radio', { name: 'Sounding chords' }))
    expect(sheetText()).toContain('F  C  G  Am')
  })

  it('offers capo alternatives as a radio group and a no-capo option', async () => {
    render(<App />)
    await paste('F  C  G  Am\n')
    await userEvent.click(screen.getByRole('radio', { name: 'Capo' }))
    const capoGroup = screen.getByRole('group', { name: 'Capo position' })
    const options = within(capoGroup).getAllByRole('radio')
    expect(options[0]).toHaveAccessibleName(/^Capo 5/)
    expect(options[0]).toBeChecked()
    await userEvent.click(within(capoGroup).getByRole('radio', { name: /No capo/ }))
    expect(screen.getByText('No capo needed.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: "I don't want a capo" }))
    expect(within(capoGroup).getAllByRole('radio')).toHaveLength(1)
  })

  it('pluralises the capo summary', async () => {
    render(<App />)
    await paste('C\nhello there\n')
    const group = screen.getByRole('group', { name: 'Capo position' })
    expect(within(group).getAllByRole('radio')[0]).toHaveAccessibleName(
      'No capo 0 barres · 1 shape',
    )
  })

  it('moves the ease/fidelity slider between fixed stops', async () => {
    render(<App />)
    await paste('F  C  G  Am\n')
    await userEvent.click(screen.getByRole('checkbox', { name: "I don't want a capo" }))
    const slider = screen.getByRole('slider', { name: /Ease/ })
    expect(slider).toHaveAttribute('aria-valuetext', 'Balanced')
    fireEvent.change(slider, { target: { value: '4' } })
    expect(slider).toHaveAttribute('aria-valuetext', 'As close as possible')
    // At the fidelity end the small F (a mini barre) beats Fmaj7.
    expect(sheetText()).toMatch(/^F\s+C/)
    await userEvent.click(screen.getByRole('radio', { name: 'Original' }))
    expect(slider).toBeDisabled()
  })

  it('transposes and shows the key', async () => {
    render(<App />)
    await paste('C  G  Am  F\n')
    expect(screen.getByText('C / Am')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Up a semitone' }))
    await userEvent.click(screen.getByRole('button', { name: 'Up a semitone' }))
    expect(screen.getByText('+2')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('radio', { name: 'Sounding chords' }))
    // Easy mode: the Bm of the new key is played as Bm7.
    expect(sheetText()).toMatch(/^D\s+A\s+Bm7\s+G/)
    expect(screen.getByText('D / Bm')).toBeInTheDocument()
  })

  it('writes chord names as Do Re Mi when asked', async () => {
    render(<App />)
    await paste('Am  C  G\n')
    await userEvent.click(screen.getByText('Settings'))
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Chord names' }), 'solfege')
    expect(sheetText()).toContain('Lam')
    expect(sheetText()).toContain('Sol')
  })

  it('browses alternative shapes, remembers the pick and can reset it', async () => {
    render(<App />)
    await paste('F  C\n')
    const card = () => document.querySelectorAll<HTMLElement>('.diagram-card')[0] as HTMLElement
    const name = () => card().querySelector('.diagram-name')?.textContent
    const suggested = name()
    expect(card()).toHaveTextContent('1 /')
    await userEvent.click(within(card()).getByRole('button', { name: 'Next shape' }))
    expect(card()).toHaveTextContent('2 /')
    expect(name()).not.toBe(suggested)
    expect(localStorage.getItem('barrefree.voicings')).toContain('easy|')
    // The sheet follows the picked shape.
    expect(sheetText()).toContain(name() ?? '?')
    await userEvent.click(within(card()).getByRole('button', { name: 'Use the suggested shape' }))
    expect(card()).toHaveTextContent('1 /')
    expect(name()).toBe(suggested)
  })

  it('highlights a chord in the sheet and its diagram when clicked', async () => {
    render(<App />)
    await paste('F  C\n')
    const chord = screen.getAllByRole('button', { name: 'C' })[0] as HTMLElement
    await userEvent.click(chord)
    expect(chord).toHaveAttribute('aria-pressed', 'true')
    expect(document.querySelector('.diagram-card.is-selected')).toHaveTextContent('C')
    await userEvent.click(chord)
    expect(chord).toHaveAttribute('aria-pressed', 'false')
  })

  it('loads the example and clears it', async () => {
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: 'Load example' }))
    await act(async () => {
      await Promise.resolve()
    })
    expect(sheetText()).toContain('Fmaj7')
    expect(localStorage.getItem('barrefree.draft')).toContain('Morning')
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
    expect(screen.getByText('No chords found yet.')).toBeInTheDocument()
    expect(localStorage.getItem('barrefree.draft')).toBeNull()
  })

  describe('review regressions', () => {
    let clipboard: string[] = []
    beforeEach(() => {
      clipboard = []
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn((text: string) => Promise.resolve(void clipboard.push(text))) },
      })
    })
    afterEach(() => vi.restoreAllMocks())

    it('reads a source capo: the chords are shapes and the stale directive is hidden', async () => {
      render(<App />)
      await paste('{capo: 3}\n[G]Walking down the [C]road today\n')
      expect(screen.getByText(/written for capo 3/)).toBeInTheDocument()
      expect(sheetText()).not.toContain('{capo')
      await userEvent.click(screen.getByRole('radio', { name: 'Sounding chords' }))
      // G and C under capo 3 sound as Bb and Eb.
      expect(sheetText()).toMatch(/^Bb\s+Eb/)
    })

    it('words the capo note and the copies for the view that is shown', async () => {
      render(<App />)
      await paste('F  C  G  Am\nla la la la\n')
      await userEvent.click(screen.getByRole('radio', { name: 'Capo' }))
      await userEvent.click(screen.getByRole('button', { name: 'Copy text' }))
      await userEvent.click(screen.getByRole('button', { name: 'Copy ChordPro' }))
      expect(clipboard[0]).toBe('Capo: 5\n\nC  G  D  Em\nla la la la\n')
      expect(clipboard[1]).toBe('{capo: 5}\n[C]la [G]la [D]la [Em]la\n')

      await userEvent.click(screen.getByRole('radio', { name: 'Sounding chords' }))
      expect(screen.getByText(/Chord names are what you hear/)).toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: 'Copy text' }))
      await userEvent.click(screen.getByRole('button', { name: 'Copy ChordPro' }))
      expect(clipboard[2]).toBe('F  C  G  Am\nla la la la\n')
      expect(clipboard[3]).toBe('[F]la [C]la [G]la [Am]la\n')
    })

    it('keeps the capo pick while lyrics change, and drops it when the chords change', async () => {
      render(<App />)
      await paste('F  C  G  Am\nla la\n')
      await userEvent.click(screen.getByRole('radio', { name: 'Capo' }))
      await userEvent.click(screen.getByRole('radio', { name: /No capo/ }))
      await paste('F  C  G  Am\nla la la\n')
      expect(screen.getByRole('radio', { name: /No capo/ })).toBeChecked()
      await paste('F  C  G  Am  F\nla la la\n')
      expect(screen.getByRole('radio', { name: /^Capo 5/ })).toBeChecked()
    })

    it('marks simplified chords and names the written chord on the card (beginner)', async () => {
      render(<App />)
      await paste('Cmaj9    Am9    G\n')
      await userEvent.click(screen.getByRole('radio', { name: 'Beginner' }))
      expect(sheetText()).toMatch(/^Cmaj7\s+Am7\s+G/)
      expect(screen.getAllByRole('button', { name: 'Cmaj7' })[0]).toHaveClass('is-substituted')
      expect(screen.getAllByRole('button', { name: 'G' })[0]).not.toHaveClass('is-substituted')
      expect(screen.getByText('for Cmaj9')).toBeInTheDocument()
      expect(screen.getByText('for Am9')).toBeInTheDocument()
    })

    it('writes the key in Do Re Mi too', async () => {
      render(<App />)
      await paste('C  G  Am  F\n')
      await userEvent.click(screen.getByText('Settings'))
      await userEvent.selectOptions(
        screen.getByRole('combobox', { name: 'Chord names' }),
        'solfege',
      )
      expect(screen.getByText('Do / Lam')).toBeInTheDocument()
    })

    it('clears the selection and focuses the text box after Clear', async () => {
      render(<App />)
      await paste('F  C\n')
      await userEvent.click(screen.getAllByRole('button', { name: 'C' })[0] as HTMLElement)
      await userEvent.click(screen.getByRole('button', { name: 'Clear' }))
      expect(screen.getByRole('textbox', { name: 'Paste chords' })).toHaveFocus()
      await paste('F  C\n')
      expect(document.querySelector('.diagram-card.is-selected')).toBeNull()
    })

    it('keeps focus in the card after resetting a picked shape', async () => {
      render(<App />)
      await paste('F  C\n')
      const card = document.querySelectorAll<HTMLElement>('.diagram-card')[0] as HTMLElement
      await userEvent.click(within(card).getByRole('button', { name: 'Next shape' }))
      await userEvent.click(within(card).getByRole('button', { name: 'Use the suggested shape' }))
      expect(within(card).getByRole('button', { name: 'Next shape' })).toHaveFocus()
    })
  })
})
