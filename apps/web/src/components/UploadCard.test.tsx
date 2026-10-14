import type { Health } from '@barrefree/contracts'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Api from '../lib/api'
import { uploadAudio, type UploadOptions } from '../lib/api'
import { UploadCard } from './UploadCard'

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  uploadAudio: vi.fn(),
}))

const health: Health = {
  status: 'ok',
  version: '0.0.0',
  features: {
    urlImport: false,
    recognizers: ['chordino', 'btc'],
    separation: true,
    transcription: true,
    maxUploadMb: 50,
    maxDurationSec: 900,
  },
}

const upload = vi.mocked(uploadAudio)

async function chooseFile() {
  await userEvent.upload(
    screen.getByLabelText('Choose an audio file'),
    new File(['x'], 'song.mp3', { type: 'audio/mpeg' }),
  )
}

describe('upload card', () => {
  beforeEach(async () => {
    upload.mockReset()
    await i18n.changeLanguage('en')
  })

  it('sends the chosen recognizer and separation, then opens the job', async () => {
    upload.mockResolvedValue('job9')
    render(<UploadCard health={health} healthLoaded />)
    await chooseFile()
    const select = screen.getByRole('combobox', { name: 'Chord recognizer' })
    expect(screen.getByRole('option', { name: /^BTC/ })).toBeInTheDocument()
    await userEvent.selectOptions(select, 'btc')
    await userEvent.click(screen.getByRole('checkbox', { name: /Separate the instruments/ }))
    await userEvent.click(screen.getByRole('button', { name: 'Find the chords' }))
    expect(upload).toHaveBeenCalledWith(
      expect.any(File),
      expect.objectContaining({ recognizer: 'btc', separate: true }),
    )
    expect(window.location.pathname).toBe('/jobs/job9')
  })

  it('hides separation when the server does not offer it', () => {
    render(
      <UploadCard
        health={{ ...health, features: { ...health.features, separation: false } }}
        healthLoaded
      />,
    )
    expect(screen.queryByRole('checkbox', { name: /Separate/ })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /write out the notes/ })).toBeInTheDocument()
  })

  it('says the server cannot analyze yet when it has no chord recognizer', () => {
    render(
      <UploadCard
        health={{
          ...health,
          status: 'degraded',
          features: { ...health.features, recognizers: [] },
        }}
        healthLoaded
      />,
    )
    expect(screen.getByText(/cannot analyze songs yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Find the chords' })).not.toBeInTheDocument()
  })

  it('cancels the upload when the page is left', async () => {
    let options: UploadOptions | undefined
    upload.mockImplementation((_file, o) => {
      options = o
      return new Promise(() => undefined)
    })
    const view = render(<UploadCard health={health} healthLoaded />)
    await chooseFile()
    await userEvent.click(screen.getByRole('button', { name: 'Find the chords' }))
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    view.unmount()
    expect(options?.signal?.aborted).toBe(true)
  })
})
