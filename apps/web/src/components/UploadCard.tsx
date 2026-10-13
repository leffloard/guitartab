import type { Health } from '@barrefree/contracts'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { ApiRequestError, uploadAudio } from '../lib/api'
import { navigate } from '../lib/router'

const ACCEPT = 'audio/*,.mp3,.wav,.flac,.ogg,.m4a'
/** Recognizers with a readable name in the locales; others are shown by their id. */
const RECOGNIZER_KEYS: readonly string[] = ['chordino', 'btc']

interface Props {
  /** Null while unknown or when the analyzer cannot be reached. */
  health: Health | null
  healthLoaded: boolean
}

/** Upload a recording for analysis: the main way into the app. */
export function UploadCard({ health, healthLoaded }: Props) {
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const recognizers = health?.features.recognizers ?? []
  const [recognizer, setRecognizer] = useState<string>('')
  const [separate, setSeparate] = useState(false)
  const canSeparate = health?.features.separation ?? false
  const sending = useRef<AbortController | null>(null)

  // Leaving the page cancels an upload in progress (it would otherwise open its job page later).
  useEffect(() => () => sending.current?.abort(), [])

  const choose = (f: File | undefined) => {
    setError(null)
    if (!f) return
    if (health && f.size > health.features.maxUploadMb * 2 ** 20) {
      setError(t('upload.error.tooLarge', { mb: health.features.maxUploadMb }))
      return
    }
    setFile(f)
  }

  const start = async () => {
    if (!file) return
    setError(null)
    setProgress(0)
    const controller = new AbortController()
    sending.current = controller
    try {
      const id = await uploadAudio(file, {
        ...(recognizer ? { recognizer } : {}),
        separate: separate && canSeparate,
        onProgress: setProgress,
        signal: controller.signal,
      })
      if (!controller.signal.aborted) navigate(`/jobs/${id}`)
    } catch (e) {
      if (controller.signal.aborted) return
      setProgress(null)
      setError(errorText(e))
    } finally {
      if (sending.current === controller) sending.current = null
    }
  }

  const cancel = () => {
    sending.current?.abort()
    setProgress(null)
  }

  const errorText = (e: unknown): string => {
    if (!(e instanceof ApiRequestError)) return t('upload.error.generic')
    if (e.status === 413) return t('upload.error.tooLong')
    if (e.status === 415) return t('upload.error.notAudio')
    if (e.status === 422) return t('upload.error.tooShort')
    if (e.status === 429) return t('upload.error.rate')
    if (e.status === 503) return t('upload.error.busy')
    if (e.status === 0) return t('upload.error.offline')
    return t('upload.error.generic')
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    choose(e.dataTransfer.files[0])
  }

  return (
    <section className="upload" aria-labelledby="upload-title">
      <h2 id="upload-title">{t('upload.title')}</h2>
      {healthLoaded && !health ? (
        <p className="hint">{t('upload.unavailable')}</p>
      ) : (
        <>
          <div
            className={`dropzone${dragging ? ' is-dragging' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <input
              ref={input}
              type="file"
              accept={ACCEPT}
              className="visually-hidden"
              id="upload-file"
              onChange={(e) => choose(e.target.files?.[0])}
            />
            <label htmlFor="upload-file" className="button">
              {t('upload.choose')}
            </label>
            <span className="hint">
              {file ? file.name : t('upload.hint', { mb: health?.features.maxUploadMb ?? 50 })}
            </span>
          </div>
          {recognizers.length > 1 && (
            <label className="field">
              {t('upload.recognizer')}
              <select value={recognizer} onChange={(e) => setRecognizer(e.target.value)}>
                <option value="">{t('upload.recognizerDefault')}</option>
                {recognizers.map((r) => (
                  <option key={r} value={r}>
                    {RECOGNIZER_KEYS.includes(r) ? t(`upload.recognizers.${r}`) : r}
                  </option>
                ))}
              </select>
            </label>
          )}
          {canSeparate && (
            <label className="check">
              <input
                type="checkbox"
                checked={separate}
                onChange={(e) => setSeparate(e.target.checked)}
              />
              <span>
                {t('upload.separate')}
                <small className="hint">{t('upload.separateHint')}</small>
              </span>
            </label>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={!file || progress !== null}
              onClick={() => void start()}
            >
              {progress === null
                ? t('upload.start')
                : t('upload.sending', { percent: Math.round(progress * 100) })}
            </button>
            {progress !== null && (
              <button type="button" onClick={cancel}>
                {t('upload.cancel')}
              </button>
            )}
          </div>
          {error && (
            <p className="warning" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </section>
  )
}
