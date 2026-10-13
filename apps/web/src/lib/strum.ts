/**
 * A strumming pattern to start with, from the time signature and tempo. Only a suggestion: the
 * analyzer does not detect the song's rhythm.
 *
 * D = down, U = up, - = a missed stroke (keep the hand moving). The common "old faithful"
 * patterns from beginner method books.
 */
export function strumPattern(
  timeSignature: string | null | undefined,
  bpm: number | null | undefined,
): string {
  const beats = Number.parseInt(timeSignature ?? '4', 10) || 4
  const fast = (bpm ?? 100) >= 140
  if (beats === 3) return fast ? 'D - D - D -' : 'D - D U D U'
  if (beats === 2) return 'D - D U'
  if (beats === 6) return 'D - U D - U'
  return fast ? 'D - D U - U D U' : 'D - D U - U D U'
}
