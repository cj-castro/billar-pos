import type { KeyboardEvent } from 'react'

// Spread onto a non-native clickable element (div/span) to give it button
// semantics and keyboard access: Enter/Space activate it, same as a real <button>.
export function clickableDivProps(onClick: () => void, disabled = false) {
  if (disabled) return {}
  return {
    role: 'button' as const,
    tabIndex: 0,
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onClick()
      }
    },
  }
}
