import { parseChordLabel } from '@barrefree/theory'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  /** What the analyzer heard, named as the chart names it. */
  detected: string
  /** The current correction, if any, as the chart names it. */
  value: string | null
  /** The chart is transposed or shows capo shapes: say that input is read the same way. */
  shifted: boolean
  /** The typed chord, or null to go back to what was heard. */
  onSave: (text: string | null) => void
  onClose: () => void
}

/**
 * Correct a chord the analyzer got wrong; the fix is kept with the song, on this device.
 *
 * A native modal `<dialog>`: the browser makes the page behind it inert, keeps focus inside and
 * closes it on Escape. Focus goes back to the chord that opened it.
 */
export function EditChordDialog({ detected, value, shifted, onSave, onClose }: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState(value ?? '')
  const dialog = useRef<HTMLDialogElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const pressedOutside = useRef(false)

  useEffect(() => {
    const opener = document.activeElement
    const element = dialog.current
    // jsdom has no showModal; the open attribute is enough there.
    if (element && typeof element.showModal === 'function') element.showModal()
    else element?.setAttribute('open', '')
    input.current?.focus()
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [])

  const parsed = text.trim() === '' ? null : parseChordLabel(text)
  const valid = parsed !== null && parsed.kind !== 'invalid'

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="edit-chord-title"
      onCancel={(e) => {
        // Escape: let React unmount the dialog instead of the browser closing it.
        e.preventDefault()
        onClose()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
      // A click on the backdrop lands on the dialog element itself. Close only when the press
      // started there too, so a text selection dragged out of the field keeps the dialog open.
      onPointerDown={(e) => {
        pressedOutside.current = e.target === e.currentTarget
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && pressedOutside.current) onClose()
        pressedOutside.current = false
      }}
    >
      <div className="dialog-body">
        <h2 id="edit-chord-title">{t('edit.title')}</h2>
        <p className="hint">{t('edit.detected', { chord: detected })}</p>
        {shifted && <p className="hint">{t('edit.frame')}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (valid) onSave(text.trim())
          }}
        >
          <label className="field">
            {t('edit.label')}
            <input
              ref={input}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('edit.placeholder')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              aria-invalid={text.trim() !== '' && !valid}
            />
          </label>
          {text.trim() !== '' && !valid && (
            <p className="warning" role="alert">
              {t('edit.invalid')}
            </p>
          )}
          <div className="actions">
            <button type="submit" className="primary" disabled={!valid}>
              {t('edit.save')}
            </button>
            {value !== null && (
              <button type="button" onClick={() => onSave(null)}>
                {t('edit.reset')}
              </button>
            )}
            <button type="button" onClick={onClose}>
              {t('edit.cancel')}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  )
}
