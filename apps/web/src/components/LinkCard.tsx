import type { Candidate, Health } from '@barrefree/contracts'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiRequestError, createUrlJob, resolveLink } from '../lib/api'
import { formatTime } from '../lib/playback'
import { navigate } from '../lib/router'

const SEPARATOR = ' · '
const details = (c: Candidate) =>
  [c.channel, c.durationSec ? formatTime(c.durationSec) : null].filter(Boolean).join(SEPARATOR)

/**
 * Analyze a song from a Spotify or YouTube link (only when the server enables it). Nothing is
 * downloaded until the user picks the exact video; the terms-of-service notice stays visible.
 */
export function LinkCard({ health }: { health: Health }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [found, setFound] = useState<{ query: string | null; candidates: Candidate[] } | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const pending = useRef<AbortController | null>(null)
  useEffect(() => () => pending.current?.abort(), [])

  const errorText = (e: unknown) =>
    e instanceof ApiRequestError && e.status === 400
      ? t('link.error.unsupported')
      : e instanceof ApiRequestError && e.status === 429
        ? t('upload.error.rate')
        : e instanceof ApiRequestError && e.status === 503
          ? t('upload.error.busy')
          : t('link.error.failed')

  const find = async () => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    setFound(null)
    setPicked(null)
    try {
      const result = await resolveLink(url, controller.signal)
      if (controller.signal.aborted) return
      setFound({ query: result.query ?? null, candidates: result.candidates })
      setPicked(result.candidates[0]?.videoId ?? null)
      if (result.candidates.length === 0) setError(t('link.error.none'))
    } catch (e) {
      if (!controller.signal.aborted) setError(errorText(e))
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const start = async () => {
    const candidate = found?.candidates.find((c) => c.videoId === picked)
    if (!candidate) return
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    setBusy(true)
    setError(null)
    try {
      const id = await createUrlJob(
        { videoId: candidate.videoId, title: candidate.title, separate: false },
        controller.signal,
      )
      // Left the page meanwhile: do not pull the user back to the job.
      if (!controller.signal.aborted) navigate(`/jobs/${id}`)
    } catch (e) {
      if (controller.signal.aborted) return
      setBusy(false)
      setError(errorText(e))
    }
  }

  return (
    <section className="link-import" aria-labelledby="link-title">
      <h2 id="link-title">{t('link.title')}</h2>
      <p className="hint">{t('link.notice')}</p>
      <form
        className="link-form"
        // Links without "https://" (youtu.be/…) are fine: the server checks them.
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (url.trim()) void find()
        }}
      >
        <label className="field">
          {t('link.label')}
          <input
            type="text"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('link.placeholder')}
            autoComplete="off"
          />
        </label>
        <button type="submit" disabled={busy || url.trim() === ''}>
          {t('link.find')}
        </button>
      </form>
      {found && found.candidates.length > 0 && (
        <fieldset className="candidates">
          <legend>
            {found.query ? t('link.searched', { query: found.query }) : t('link.confirm')}
          </legend>
          {found.candidates.map((c) => (
            <label
              key={c.videoId}
              className={`candidate${picked === c.videoId ? ' is-active' : ''}`}
            >
              <input
                type="radio"
                name="candidate"
                value={c.videoId}
                checked={picked === c.videoId}
                onChange={() => setPicked(c.videoId)}
              />
              <span>
                <strong>{c.title}</strong>
                <small>
                  {details(c)}{' '}
                  <a href={c.url} target="_blank" rel="noreferrer noopener">
                    {t('link.open')}
                  </a>
                </small>
              </span>
            </label>
          ))}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !picked}
              onClick={() => void start()}
            >
              {t('link.analyze')}
            </button>
          </div>
        </fieldset>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <p className="hint">
        {t('link.limits', { minutes: Math.round(health.features.maxDurationSec / 60) })}
      </p>
    </section>
  )
}
