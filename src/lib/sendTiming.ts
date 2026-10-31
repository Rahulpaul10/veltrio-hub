/**
 * Development timing marks for the Confirm -> wallet path. Records only names and durations in milliseconds
 * (never addresses, amounts or hashes). Logged to the console in development builds only.
 */
const marks: Array<{ name: string; at: number }> = []

export function markSend(name: string): void {
  if (name === 'click') marks.length = 0
  marks.push({ name, at: performance.now() })
}

export function sendTimeline(): ReadonlyArray<{ name: string; at: number }> {
  return marks
}

export function reportSend(): void {
  if (!import.meta.env.DEV || marks.length === 0) return
  const first = marks[0]?.at ?? 0
  console.info(`[veltrio:timing] ${marks.map((m) => `${m.name}+${Math.round(m.at - first)}ms`).join(' ')}`)
}
