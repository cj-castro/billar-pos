/**
 * Placeholder design tokens: slate surfaces + sky accent, dark only (D11), derived from the web palette.
 * TODO: mirror docs/mobile/design/tokens.json once the UI Designer delivers it (not present yet).
 */
export const colors = {
  bg: '#0f172a', // slate-900
  surface: '#1e293b', // slate-800
  surfaceAlt: '#334155', // slate-700
  border: '#334155',
  text: '#f1f5f9', // slate-100
  textMuted: '#94a3b8', // slate-400
  accent: '#0ea5e9', // sky-500
  accentPressed: '#0284c7', // sky-600
  onAccent: '#ffffff',
  danger: '#ef4444',
  warning: '#f59e0b',
  success: '#22c55e',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;
export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;
export const font = { sm: 13, md: 16, lg: 20, xl: 28 } as const;
/** Minimum touch target (Material 48dp / HIG 44pt). */
export const minTouch = 48;
