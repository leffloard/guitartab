import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Link } from '../components/Link'
import { formatTime } from '../lib/playback'
import { deleteSong, listSongs, type SongSummary } from '../lib/library'

/** Songs analyzed on this device. */
export function LibraryPage() {
  const { t, i18n } = useTranslation()
  const [songs, setSongs] = useState<SongSummary[] | null>(null)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    let cancelled = false
    listSongs().then(
      (list) => {
        if (!cancelled) setSongs(list)
      },
      () => {
        if (!cancelled) setUnavailable(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [])

  const remove = async (song: SongSummary) => {
    if (!window.confirm(t('library.confirmDelete', { title: song.title }))) return
    await deleteSong(song.id)
    setSongs((list) => list?.filter((s) => s.id !== song.id) ?? null)
  }

  return (
    <section className="library" aria-labelledby="library-title">
      <h2 id="library-title">{t('library.title')}</h2>
      <p className="hint">{t('library.hint')}</p>
      {unavailable ? (
        <p className="warning" role="alert">
          {t('library.unavailable')}
        </p>
      ) : songs === null ? null : songs.length === 0 ? (
        <p>
          {t('library.empty')} <Link href="/">{t('library.analyze')}</Link>
        </p>
      ) : (
        <ul className="song-list">
          {songs.map((song) => (
            <li key={song.id}>
              <Link href={`/songs/${song.id}`} className="song-link">
                <strong>{song.title}</strong>
                <small>
                  {[
                    formatTime(song.durationSec),
                    song.key
                      ? t('library.key', {
                          tonic: song.key.tonic,
                          mode: t(`library.mode.${song.key.mode}`),
                        })
                      : null,
                    new Date(song.createdAt).toLocaleDateString(i18n.resolvedLanguage),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </small>
              </Link>
              <button
                type="button"
                className="link"
                aria-label={t('library.delete', { title: song.title })}
                onClick={() => void remove(song)}
              >
                {t('library.deleteShort')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
