/** Playback speeds offered by the player: slower practice speeds, pitch preserved. */
export const RATES = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 1] as const

/** `m:ss` for a time in seconds (negative times show as 0:00). */
export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A song title from an uploaded file name: no extension, underscores as spaces. */
export function titleFromFileName(name: string): string {
  return (
    name
      .replace(/\.[a-z0-9]{2,4}$/i, '')
      .replace(/[_]+/g, ' ')
      .trim() || name
  )
}
