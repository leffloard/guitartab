import type { JobInfo } from '@barrefree/contracts'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import i18n from 'i18next'
import type { ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { App } from '../App'
import type * as PlayerModule from '../components/Player'
import type { Player } from '../components/Player'
import { getSong, listSongs, saveSong } from '../lib/library'
import { analysis, song } from '../test/fixtures'

type PlayerProps = ComponentProps<typeof Player>
const player: { props: PlayerProps | null; seeks: number[]; time: number } = {
  props: null,
  seeks: [],
  time: 0,
}

vi.mock('../components/Player', async (importOriginal) => {
  const actual = await importOriginal<typeof PlayerModule>()
  return {
    ...actual,
    Player: (props: PlayerProps) => {
      player.props = props
      if (props.ref && typeof props.ref === 'object') {
        props.ref.current = {
          seek: (t: number) => void player.seeks.push(t),
          toggle: () => undefined,
          time: () => player.time,
        }
      }
      return <div data-testid="player" />
    },
  }
})

function at(path: string) {
  window.history.replaceState(null, '', path)
  return render(<App />)
}

async function playAt(time: number) {
  player.time = time
  await act(async () => {
    player.props?.onTime(time)
    await Promise.resolve()
  })
}

beforeEach(async () => {
  player.props = null
  player.seeks = []
  player.time = 0
  await i18n.changeLanguage('en')
})

describe('song page', () => {
  it('follows the playback with the current and next chord and a beat countdown', async () => {
    await saveSong(song(), new Blob(['x'], { type: 'audio/mp4' }))
    at('/songs/song1')
    expect(await screen.findByRole('heading', { name: 'Test Song' })).toBeInTheDocument()
    expect(screen.getByText('120 BPM')).toBeInTheDocument()
    expect(screen.getByText(/Strumming suggestion: D - D U - U D U/)).toBeInTheDocument()

    // Before playing, the strip already shows the first chord and the first change.
    const strip = screen.getByRole('region', { name: 'Current chord' })
    expect(within(strip).getByText('C')).toHaveClass('strip-chord')
    expect(within(strip).getByText('in 4 beats')).toBeInTheDocument()

    await playAt(0.6)
    expect(within(strip).getByText('C')).toHaveClass('strip-chord')
    expect(within(strip).getByText('G')).toBeInTheDocument()
    expect(within(strip).getByText('in 3 beats')).toBeInTheDocument()

    // Right on the change there is no "in 0 beats".
    await playAt(1.98)
    expect(within(strip).queryByText(/^in /)).toBeNull()

    // Easy mode plays the F as Fmaj7; the analyzer was unsure about it.
    await playAt(4.2)
    expect(within(strip).getByText('Fmaj7')).toHaveClass('is-uncertain')
    expect(within(strip).getByText('in 4 beats')).toBeInTheDocument()
    expect(screen.getByText(/1 chord is uncertain/)).toBeInTheDocument()

    // Tapping a chord in the chart seeks there.
    await userEvent.click(screen.getByRole('button', { name: 'Am' }))
    expect(player.seeks).toEqual([3])
  })

  it('corrects an uncertain chord and keeps the fix in the library', async () => {
    await saveSong(song(), new Blob(['x']))
    at('/songs/song1')
    await screen.findByRole('heading', { name: 'Test Song' })
    await userEvent.click(screen.getByRole('button', { name: 'Fix chords' }))
    await userEvent.click(screen.getByRole('button', { name: 'Fmaj7 (uncertain, check by ear)' }))
    const dialog = screen.getByRole('dialog', { name: 'Fix this chord' })
    expect(within(dialog).getByText('Heard as: F')).toBeInTheDocument()
    const input = within(dialog).getByRole('textbox', { name: 'Chord' })
    await userEvent.type(input, 'Xyz')
    expect(within(dialog).getByRole('alert')).toBeInTheDocument()
    await userEvent.clear(input)
    await userEvent.type(input, 'Dm')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dm' })).toHaveClass('is-edited')
    expect(screen.queryByText(/is uncertain/)).not.toBeInTheDocument()
    // Stored as the canonical Harte label, at the recording's pitch.
    await waitFor(async () => expect((await getSong('song1'))?.edits).toEqual({ 3: 'D:min' }))
  })

  it('reads a fix in the frame the chart shows and can undo a fix to no chord', async () => {
    await saveSong(song(), new Blob(['x']))
    at('/songs/song1')
    await screen.findByRole('heading', { name: 'Test Song' })
    // Original chords, two semitones up, sounding names: C G Am F C reads D A Bm G D.
    await userEvent.click(screen.getByRole('radio', { name: 'Original' }))
    await userEvent.click(screen.getByRole('radio', { name: 'Sounding chords' }))
    await userEvent.click(screen.getByRole('button', { name: 'Up a semitone' }))
    await userEvent.click(screen.getByRole('button', { name: 'Up a semitone' }))
    await userEvent.click(screen.getByRole('button', { name: 'Fix chords' }))
    await userEvent.click(screen.getByRole('button', { name: 'Bm' }))
    let dialog = screen.getByRole('dialog', { name: 'Fix this chord' })
    expect(within(dialog).getByText('Heard as: Bm')).toBeInTheDocument()
    expect(within(dialog).getByText(/the way this chart writes chords/)).toBeInTheDocument()
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Chord' }), 'D')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    // D as shown is C as recorded.
    await waitFor(async () => expect((await getSong('song1'))?.edits).toEqual({ 2: 'C:maj' }))
    const chart = screen.getByRole('list', { name: /^Chord chart/ })
    expect(
      within(chart)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['D', 'A', 'D', 'G', 'D'])
    expect(within(chart).getAllByRole('button')[2]).toHaveClass('is-edited')

    // A fix to "no chord" stays in the chart as N.C. and can be undone.
    await userEvent.click(within(chart).getByRole('button', { name: 'A' }))
    dialog = screen.getByRole('dialog', { name: 'Fix this chord' })
    await userEvent.type(within(dialog).getByRole('textbox', { name: 'Chord' }), 'N.C.')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(async () => expect((await getSong('song1'))?.edits[1]).toBe('N'))
    await userEvent.click(screen.getByRole('button', { name: 'No chord (N.C.)' }))
    dialog = screen.getByRole('dialog', { name: 'Fix this chord' })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Use what was heard' }))
    await waitFor(async () => expect((await getSong('song1'))?.edits).toEqual({ 2: 'C:maj' }))
  })

  it('remembers the arrangement controls with the song', async () => {
    await saveSong(song(), new Blob(['x']))
    const view = at('/songs/song1')
    await screen.findByRole('heading', { name: 'Test Song' })
    await userEvent.click(screen.getByRole('radio', { name: 'Original' }))
    await waitFor(async () => expect((await getSong('song1'))?.view?.mode).toBe('original'), {
      timeout: 2000,
    })
    view.unmount()
    at('/songs/song1')
    await screen.findByRole('heading', { name: 'Test Song' })
    expect(screen.getByRole('radio', { name: 'Original' })).toBeChecked()
    expect(screen.getByRole('button', { name: /^F \(uncertain/ })).toBeInTheDocument()
  })

  it('says so when the song is not on this device', async () => {
    at('/songs/nope')
    expect(await screen.findByText(/not in your library/)).toBeInTheDocument()
  })
})

describe('library page', () => {
  it('lists songs and deletes one after confirming', async () => {
    await saveSong(song('a'))
    await saveSong({ ...song('b'), title: 'Other', createdAt: song().createdAt + 1 })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    at('/library')
    expect(await screen.findByRole('link', { name: /Other/ })).toHaveAttribute('href', '/songs/b')
    await userEvent.click(screen.getByRole('button', { name: 'Delete Test Song' }))
    await waitFor(() => expect(screen.queryByText('Test Song')).not.toBeInTheDocument())
    expect((await listSongs()).map((s) => s.id)).toEqual(['b'])
  })

  it('shows an empty state', async () => {
    at('/library')
    expect(await screen.findByText('No songs yet.')).toBeInTheDocument()
  })
})

class FakeEventSource {
  static last: FakeEventSource | null = null
  static readonly CLOSED = 2
  readyState = 1
  onerror: (() => void) | null = null
  listeners = new Map<string, (e: MessageEvent<string>) => void>()
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeEventSource.last = this
  }
  addEventListener(type: string, fn: (e: MessageEvent<string>) => void) {
    this.listeners.set(type, fn)
  }
  emit(type: string, data: unknown) {
    this.listeners.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
  close() {
    this.readyState = 2
  }
}

function jobInfo(over: Partial<JobInfo>): JobInfo {
  return {
    id: 'job1',
    status: 'running',
    stage: 'beats',
    progress: 0.3,
    error: null,
    source: { kind: 'upload', name: 'My_Song.mp3', url: null },
    options: { recognizer: 'chordino', separate: false, transcribe: false },
    createdAt: 1,
    updatedAt: 2,
    expiresAt: 3,
    result: null,
    ...over,
  }
}

describe('job page', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shows live progress, then saves the song and opens it', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/audio')
          ? new Response('audio', { status: 200, headers: { 'content-type': 'audio/mp4' } })
          : url.endsWith('/health')
            ? new Response('{}', { status: 503 })
            : Response.json(
                jobInfo({ status: 'done', stage: 'done', progress: 1, result: analysis() }),
              ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    at('/jobs/job1')
    await waitFor(() => expect(FakeEventSource.last?.url).toBe('/api/jobs/job1/events'))
    act(() => FakeEventSource.last?.emit('job', jobInfo({})))
    expect(screen.getByRole('heading', { name: 'My Song' })).toBeInTheDocument()
    expect(screen.getByText('Finding the beat')).toHaveClass('is-current')
    expect(screen.getByText('Reading the audio')).toHaveClass('is-done')

    act(() => FakeEventSource.last?.emit('end', 'done'))
    await waitFor(() => expect(window.location.pathname).toBe('/songs/job1'))
    const saved = await getSong('job1')
    expect(saved).toMatchObject({ title: 'My Song', edits: {} })
    expect(saved?.analysis.chords).toHaveLength(5)
  })

  it('reports a failed analysis', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.last = null
    at('/jobs/job1')
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull())
    act(() => {
      FakeEventSource.last?.emit(
        'job',
        jobInfo({ status: 'failed', stage: 'failed', error: 'Bad audio.' }),
      )
      FakeEventSource.last?.emit('end', 'failed')
    })
    // The message is the UI's own; the server's English text is only in the details.
    expect(await screen.findByRole('alert')).toHaveTextContent('The analysis failed.')
    expect(screen.getByText('Bad audio.').closest('details')).not.toBeNull()
  })

  it('never replaces a saved song when its job page is opened again', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.last = null
    await saveSong({ ...song('job1'), edits: { 1: 'E:min' } }, new Blob(['x']))
    at('/jobs/job1')
    expect(await screen.findByRole('heading', { name: 'Test Song' })).toBeInTheDocument()
    expect(window.location.pathname).toBe('/songs/job1')
    expect(FakeEventSource.last).toBeNull()
    expect((await getSong('job1'))?.edits).toEqual({ 1: 'E:min' })
  })

  it('reconnects when the event stream drops while the job is still running', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.last = null
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(jobInfo({})), { status: 200 }))),
    )
    at('/jobs/job1')
    await waitFor(() => expect(FakeEventSource.last).not.toBeNull())
    act(() => {
      const source = FakeEventSource.last!
      source.readyState = FakeEventSource.CLOSED
      source.onerror?.()
    })
    expect(await screen.findByText(/reconnecting/)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
