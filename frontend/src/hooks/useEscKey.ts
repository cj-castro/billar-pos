import { useEffect } from 'react'

/** Calls `onClose` when the Escape key is pressed, while `active` is true. */
export function useEscKey(onClose: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose, active])
}
