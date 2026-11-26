/**
 * The venue this POS runs in (batch D1): name, timezone, currency, locale, logo.
 *
 * Loaded once from the public GET /api/v1/venue by <VenueGate> before the app
 * renders, and refreshed when the owner changes it in Ajustes. Plain functions
 * (money formatting, dates, printed slips) read it from here; React components
 * can use the useVenue() hook to re-render on change.
 */
import { LOGO_BASE64 } from './logoBase64'

export interface Venue {
  name: string
  timezone: string
  currency: string
  locale: string
  /** data URL uploaded in Ajustes; null = the build's default logo */
  logo: string | null
  /** closing hour "HH:MM": sales before it belong to the previous business day */
  day_cutoff: string
}

let current: Venue = {
  name: 'Mi Billar',
  timezone: 'America/Mexico_City',
  currency: 'MXN',
  locale: 'es-MX',
  logo: null,
  day_cutoff: '00:00',
}
const listeners = new Set<() => void>()

export function getVenue(): Venue { return current }

export function setVenue(v: Partial<Venue>) {
  current = { ...current, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x != null && x !== '')) , logo: v.logo ?? null }
  listeners.forEach(fn => fn())
}

export function onVenueChange(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Logo to show/print: the uploaded one, else the build's default. */
export function venueLogo(): string { return current.logo || LOGO_BASE64 }

/** Date/time on the bar's clock, in the venue's language. */
export function formatLocal(iso: string | Date | null | undefined,
                            opts: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' }): string {
  if (!iso) return ''
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return d.toLocaleString(current.locale, { timeZone: current.timezone, ...opts })
}

/** "HH:MM" on the bar's clock. */
export function formatLocalTime(iso: string | null | undefined): string {
  return formatLocal(iso, { hour: '2-digit', minute: '2-digit' })
}
