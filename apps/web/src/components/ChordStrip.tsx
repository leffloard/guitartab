import { useTranslation } from 'react-i18next'

interface Props {
  current: string | null
  next: string | null
  /** Beats until the next change (null without a beat grid). */
  beats: number | null
  seconds: number | null
  uncertain: boolean
}

/** The chord to play now, big, and the next one with a countdown. */
export function ChordStrip({ current, next, beats, seconds, uncertain }: Props) {
  const { t } = useTranslation()
  return (
    <section className="strip" aria-label={t('strip.label')} aria-live="off">
      <div className="strip-now">
        <span className="strip-caption">{t('strip.now')}</span>
        <strong className={`strip-chord${uncertain ? ' is-uncertain' : ''}`}>
          {current ?? t('strip.none')}
        </strong>
      </div>
      <div className="strip-next">
        <span className="strip-caption">{t('strip.next')}</span>
        <span className="strip-chord-small">{next ?? t('strip.none')}</span>
        {next && (
          <span className="strip-count">
            {beats !== null
              ? t('strip.inBeats', { count: beats })
              : seconds !== null && seconds > 0
                ? t('strip.inSeconds', { seconds: seconds.toFixed(1) })
                : null}
          </span>
        )}
      </div>
    </section>
  )
}
