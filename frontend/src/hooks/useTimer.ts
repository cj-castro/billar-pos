import { useState, useEffect } from 'react'

export function useTimer(startTimeIso: string | undefined): string {
  const [elapsed, setElapsed] = useState('')

  useEffect(() => {
    if (!startTimeIso) return

    const tick = () => {
      const start = new Date(startTimeIso).getTime()
      const now = Date.now()
      const diff = Math.max(0, Math.floor((now - start) / 1000))
      const h = Math.floor(diff / 3600)
      const m = Math.floor((diff % 3600) / 60)
      const s = diff % 60
      setElapsed(
        h > 0
          ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
          : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
      )
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [startTimeIso])

  return elapsed
}
