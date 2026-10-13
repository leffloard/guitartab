import type { Health } from '@barrefree/contracts'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Api from '../lib/api'
import { ApiRequestError, createUrlJob, resolveLink } from '../lib/api'
import { LinkCard } from './LinkCard'

vi.mock('../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof Api>()),
  resolveLink: vi.fn(),
  createUrlJob: vi.fn(),
}))

const health: Health = {
  status: 'ok',
  version: '0.0.0',
  features: {
    urlImport: true,
    recognizers: ['chordino'],
    separation: false,
    maxUploadMb: 50,
    maxDurationSec: 900,
  },
}

const candidate = (videoId: string, title: string) => ({
  videoId,
  title,
  channel: 'A Channel',
  durationSec: 215,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  thumbnail: null,
})

describe('link card', () => {
  beforeEach(async () => {
    vi.mocked(resolveLink).mockReset()
    vi.mocked(createUrlJob).mockReset()
    await i18n.changeLanguage('en')
  })

  it('shows the terms notice and starts only the video the user picked', async () => {
    vi.mocked(resolveLink).mockResolvedValue({
      title: 'Placeholder Song',
      artist: 'Some Artist',
      query: 'Some Artist Placeholder Song',
      candidates: [candidate('aaaaaaaaaaa', 'First take'), candidate('bbbbbbbbbbb', 'Second take')],
    })
    vi.mocked(createUrlJob).mockResolvedValue('job7')
    render(<LinkCard health={health} />)
    expect(screen.getByText(/terms of service/)).toBeInTheDocument()
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Link' }),
      'https://open.spotify.com/track/x',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Find' }))
    expect(
      await screen.findByText(/Videos found for “Some Artist Placeholder Song”/),
    ).toBeInTheDocument()
    expect(createUrlJob).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('radio', { name: /Second take/ }))
    expect(screen.getAllByText(/3:35/)).toHaveLength(2)
    await userEvent.click(screen.getByRole('button', { name: 'Analyze this video' }))
    expect(createUrlJob).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: 'bbbbbbbbbbb', title: 'Second take' }),
      expect.any(AbortSignal),
    )
    expect(window.location.pathname).toBe('/jobs/job7')
  })

  it('accepts links without https:// and stays put when left mid-request', async () => {
    vi.mocked(resolveLink).mockResolvedValue({
      title: 'Direct',
      artist: null,
      query: null,
      candidates: [candidate('ccccccccccc', 'Caprice No.24')],
    })
    let signal: AbortSignal | undefined
    vi.mocked(createUrlJob).mockImplementation((_request, s) => {
      signal = s
      return new Promise(() => undefined)
    })
    const view = render(<LinkCard health={health} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Link' }), 'youtu.be/ccccccccccc')
    await userEvent.click(screen.getByRole('button', { name: 'Find' }))
    expect(resolveLink).toHaveBeenCalledWith('youtu.be/ccccccccccc', expect.anything())
    await userEvent.click(await screen.findByRole('button', { name: 'Analyze this video' }))
    view.unmount()
    expect(signal?.aborted).toBe(true)
  })

  it('explains links it cannot use', async () => {
    vi.mocked(resolveLink).mockRejectedValue(new ApiRequestError(400, 'nope'))
    render(<LinkCard health={health} />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Link' }), 'https://example.com/a.mp3')
    await userEvent.click(screen.getByRole('button', { name: 'Find' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/not a Spotify track or YouTube/)
  })
})
