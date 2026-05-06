import { useEffect, useRef, useCallback } from 'react'

/**
 * Global KDS alert hook.
 *
 * Plays a repeating beep while `sentCount > 0` AND `soundEnabled` is true.
 * Stops immediately when either condition becomes false.
 *
 * AudioContext is created lazily on the first user gesture (click / keydown /
 * touchstart) to satisfy browser and Fire TV Stick autoplay restrictions.
 * The Fire TV remote D-pad click counts as a user gesture.
 *
 * One shared interval drives a single beep — no per-order audio stacking.
 */
export function useKDSAlert(sentCount: number, soundEnabled: boolean) {
  const ctxRef   = useRef<AudioContext | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Lazily create and prime the AudioContext on first user interaction.
  useEffect(() => {
    const prime = () => {
      if (ctxRef.current) return
      const Ctx =
        window.AudioContext ??
        ((window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
      if (!Ctx) return
      ctxRef.current = new Ctx()
    }
    document.addEventListener('click',      prime)
    document.addEventListener('keydown',    prime)
    document.addEventListener('touchstart', prime, { passive: true })
    return () => {
      document.removeEventListener('click',      prime)
      document.removeEventListener('keydown',    prime)
      document.removeEventListener('touchstart', prime)
    }
  }, [])

  const beep = useCallback(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const osc  = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.type = 'square'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.12, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25)
    osc.start(ctx.currentTime)
    osc.stop(ctx.currentTime + 0.25)
  }, [])

  // `active` is a stable boolean — effect only re-runs when it flips.
  const active = sentCount > 0 && soundEnabled

  useEffect(() => {
    if (!active) return
    beep()
    timerRef.current = setInterval(beep, 2500)
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [active, beep])
}
