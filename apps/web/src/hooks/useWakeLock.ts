import { useEffect } from 'react'

/**
 * Keeps the screen on while `active` (Screen Wake Lock API). The lock is released by the
 * browser when the page is hidden, so it is requested again when the page becomes visible.
 * Unsupported browsers and refusals are ignored.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let sentinel: WakeLockSentinel | null = null
    let cancelled = false
    const request = async () => {
      try {
        const lock = await navigator.wakeLock.request('screen')
        if (cancelled) await lock.release()
        else sentinel = lock
      } catch {
        // not allowed (e.g. battery saver, no user gesture yet): nothing to do
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void request()
    }
    void request()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => undefined)
    }
  }, [active])
}
