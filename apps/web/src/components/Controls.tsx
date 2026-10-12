import { LAMBDA_STOPS, type CapoOption, type Mode } from '@barrefree/theory'
import { useTranslation } from 'react-i18next'

import { CHORD_DISPLAYS, MODES, type ChordDisplay } from '../lib/arrangement'

interface Props {
  mode: Mode
  onMode: (mode: Mode) => void
  lambdaIndex: number
  onLambdaIndex: (index: number) => void
  alternatives: CapoOption[]
  capo: number | null
  onCapo: (capo: number) => void
  noCapo: boolean
  onNoCapo: (value: boolean) => void
  transpose: number
  onTranspose: (value: number) => void
  display: ChordDisplay
  onDisplay: (value: ChordDisplay) => void
  keyName: string | null
  infeasible: boolean
}

const SIGNS = { minus: '−', plus: '+' } as const
const SEPARATOR = ' · '

export function Controls(p: Props) {
  const { t } = useTranslation()
  const sliderDisabled = p.mode === 'original' || p.mode === 'capo'
  return (
    <section className="controls" aria-label={t('controls.label')}>
      <fieldset className="segmented">
        <legend>{t('mode.label')}</legend>
        {MODES.map((m) => (
          <label key={m} className={p.mode === m ? 'is-active' : undefined}>
            <input
              type="radio"
              name="mode"
              value={m}
              checked={p.mode === m}
              onChange={() => p.onMode(m)}
            />
            {t(`mode.${m}`)}
          </label>
        ))}
      </fieldset>
      <p className="hint">{t(`mode.hint.${p.mode}`)}</p>

      <label className="slider">
        <span>{t('slider.label')}</span>
        <input
          type="range"
          min={0}
          max={LAMBDA_STOPS.length - 1}
          step={1}
          value={p.lambdaIndex}
          disabled={sliderDisabled}
          aria-valuetext={t(`slider.stop.${p.lambdaIndex}`)}
          onChange={(e) => p.onLambdaIndex(Number(e.target.value))}
        />
        <span className="slider-ends">
          <span>{t('slider.ease')}</span>
          <span>{t('slider.fidelity')}</span>
        </span>
      </label>

      <div className="capo">
        {p.infeasible ? (
          <p className="warning">{t('capo.infeasible')}</p>
        ) : (
          <fieldset className="capo-options">
            <legend className="visually-hidden">{t('capo.label')}</legend>
            {p.alternatives.map((o) => {
              const checked = o.capo === (p.capo ?? p.alternatives[0]?.capo)
              return (
                <label key={o.capo} className={checked ? 'is-active' : undefined}>
                  <input
                    type="radio"
                    name="capo"
                    value={o.capo}
                    checked={checked}
                    onChange={() => p.onCapo(o.capo)}
                  />
                  <strong>
                    {o.capo === 0 ? t('capo.none') : t('capo.value', { capo: o.capo })}
                  </strong>{' '}
                  <small>
                    {t('capo.barres', { count: o.fullBarres + o.miniBarres })}
                    {SEPARATOR}
                    {t('capo.shapes', { count: o.distinctShapes })}
                  </small>
                </label>
              )
            })}
          </fieldset>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={p.noCapo}
            onChange={(e) => p.onNoCapo(e.target.checked)}
          />
          {t('capo.noCapo')}
        </label>
      </div>

      <div className="row">
        <div className="transpose" role="group" aria-label={t('transpose.label')}>
          <span>{t('transpose.label')}</span>
          <button
            type="button"
            aria-label={t('transpose.down')}
            onClick={() => p.onTranspose(p.transpose - 1)}
          >
            {SIGNS.minus}
          </button>
          <output>
            {t('transpose.value', { value: p.transpose > 0 ? `+${p.transpose}` : p.transpose })}
          </output>
          <button
            type="button"
            aria-label={t('transpose.up')}
            onClick={() => p.onTranspose(p.transpose + 1)}
          >
            {SIGNS.plus}
          </button>
        </div>
        {p.keyName && (
          <p className="key">
            {t('key.label')}: <strong>{p.keyName}</strong>
          </p>
        )}
      </div>

      <fieldset className="segmented small">
        <legend>{t('display.label')}</legend>
        {CHORD_DISPLAYS.map((d) => (
          <label key={d} className={p.display === d ? 'is-active' : undefined}>
            <input
              type="radio"
              name="display"
              value={d}
              checked={p.display === d}
              onChange={() => p.onDisplay(d)}
            />
            {t(`display.${d}`)}
          </label>
        ))}
      </fieldset>
    </section>
  )
}
