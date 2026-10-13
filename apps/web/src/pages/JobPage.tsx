import type { JobInfo } from '@barrefree/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Link } from '../components/Link'
import { ApiRequestError, fetchJob, fetchJobAudio, watchJob } from '../lib/api'
import { getSong, isQuotaError, saveSong } from '../lib/library'
import { titleFromFileName } from '../lib/playback'
import { navigate } from '../lib/router'

type JobStage = JobInfo['stage']

type Phase =
  'waiting' | 'reconnecting' | 'saving' | 'failed' | 'expired' | 'saveFailed' | 'storageFull'

function stagesFor(job: JobInfo | null): JobStage[] {
  const stages: JobStage[] = ['decoding']
  if (job?.options.separate) stages.push('separating')
  stages.push('beats', 'chords', 'key')
  if (job?.options.transcribe) stages.push('notes')
  return stages
}

const isGone = (error: unknown) => error instanceof ApiRequestError && error.status === 404

/** Live progress of an analysis; when it is done the song is saved to the library and opened. */
export function JobPage({ id }: { id: string }) {
  const { t } = useTranslation()
  const [job, setJob] = useState<JobInfo | null>(null)
  const [phase, setPhase] = useState<Phase>('waiting')
  const finishing = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** Saves the result and the audio, then opens the song; keeps going if the page is left. */
  const finish = useCallback(async () => {
    if (finishing.current) return
    finishing.current = true
    setPhase('saving')
    try {
      const done = await fetchJob(id)
      if (!done.result) throw new Error('no result')
      const audio = await fetchJobAudio(id)
      // saveSong never replaces a saved song: it may already carry the user's fixes.
      await saveSong(
        {
          id,
          title: titleFromFileName(done.source.name),
          createdAt: Date.now(),
          source: done.source,
          analysis: done.result,
          edits: {},
        },
        audio,
      )
      // Ask the browser not to evict the library under storage pressure.
      void navigator.storage?.persist?.()
      if (mounted.current) navigate(`/songs/${id}`, { replace: true })
    } catch (error) {
      finishing.current = false
      if (!mounted.current) return
      setPhase(isGone(error) ? 'expired' : isQuotaError(error) ? 'storageFull' : 'saveFailed')
    }
  }, [id])

  useEffect(() => {
    let cancelled = false
    let stop: (() => void) | null = null
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempts = 0

    const follow = () => {
      stop = watchJob(id, (event) => {
        if (cancelled) return
        if (event.type === 'job') {
          attempts = 0
          setJob(event.job)
          setPhase((p) => (p === 'reconnecting' ? 'waiting' : p))
        } else if (event.type === 'end') {
          if (event.outcome === 'done') void finish()
          else setPhase(event.outcome === 'failed' ? 'failed' : 'expired')
        } else void lost()
      })
    }
    // The stream closed without an "end": the job is gone (404), or the server or a proxy
    // hiccuped (a restart answers 502/503). Ask for the job before calling it expired.
    const lost = async () => {
      try {
        const info = await fetchJob(id)
        if (cancelled) return
        setJob(info)
        if (info.status === 'done') void finish()
        else if (info.status === 'failed') setPhase('failed')
        else reconnect()
      } catch (error) {
        if (cancelled) return
        if (!isGone(error)) reconnect()
        else if (await getSong(id).catch(() => undefined)) {
          navigate(`/songs/${id}`, { replace: true })
        } else setPhase('expired')
      }
    }
    const reconnect = () => {
      setPhase('reconnecting')
      attempts += 1
      retry = setTimeout(follow, Math.min(30_000, 1000 * 2 ** attempts))
    }

    // Opened again after the song was saved: go straight to it, and never follow the job,
    // whose result must not replace the saved song.
    getSong(id)
      .catch(() => undefined)
      .then((song) => {
        if (cancelled) return
        if (song) navigate(`/songs/${id}`, { replace: true })
        else follow()
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
      stop?.()
      clearTimeout(retry)
    }
  }, [id, finish])

  const stages = stagesFor(job)
  const current = job ? stages.indexOf(job.stage) : -1
  const title = job ? titleFromFileName(job.source.name) : null

  return (
    <section className="job" aria-labelledby="job-title" aria-busy={phase === 'waiting'}>
      <h2 id="job-title">{title ?? t('job.title')}</h2>
      {phase === 'failed' ? (
        <>
          <p className="warning" role="alert">
            {t('job.failed')}
          </p>
          {job?.error && (
            // The server's own words (in English), for a bug report.
            <details className="hint">
              <summary>{t('job.details')}</summary>
              <span lang="en">{job.error}</span>
            </details>
          )}
          <Link href="/">{t('job.again')}</Link>
        </>
      ) : phase === 'saveFailed' || phase === 'storageFull' ? (
        <>
          <p className="warning" role="alert">
            {phase === 'storageFull' ? t('job.storageFull') : t('job.saveFailed')}
          </p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => void finish()}>
              {t('job.retry')}
            </button>
            {phase === 'storageFull' && <Link href="/library">{t('nav.library')}</Link>}
          </div>
        </>
      ) : phase === 'expired' ? (
        <>
          <p className="warning" role="alert">
            {t('job.expired')}
          </p>
          <Link href="/">{t('job.again')}</Link>
        </>
      ) : (
        <>
          <progress max={1} value={job?.progress ?? 0} aria-label={t('job.progress')} />
          <ol className="stages">
            {stages.map((stage, i) => (
              <li
                key={stage}
                className={
                  job?.status === 'done' || i < current
                    ? 'is-done'
                    : i === current
                      ? 'is-current'
                      : undefined
                }
              >
                {t(`job.stage.${stage}`)}
              </li>
            ))}
          </ol>
          <p className="hint" aria-live="polite">
            {phase === 'saving'
              ? t('job.saving')
              : phase === 'reconnecting'
                ? t('job.reconnecting')
                : job?.status === 'queued'
                  ? t('job.queued')
                  : t('job.working')}
          </p>
        </>
      )}
    </section>
  )
}
