/**
 * Centralized MXN money formatting. Single source of truth — replaces the
 * three duplicated `cents()` / `c()` helpers that lived in ReportsPage,
 * CashSessionPage, and printCashReconciliation.
 *
 * `Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })`
 * produces the Mexican format: "$1,252.00" with comma thousands separator
 * and period decimal. Always 2 fraction digits, even for whole pesos.
 */

import { getVenue, onVenueChange } from './venue'

// Formatters follow the venue's currency and locale (batch D1); rebuilt when
// the owner changes them. Defaults: MXN / es-MX.
let MXN: Intl.NumberFormat
let MXN_PRECISE: Intl.NumberFormat
function build() {
  const { currency, locale } = getVenue()
  MXN = new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  })
  MXN_PRECISE = new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 4,
  })
}
build()
onVenueChange(build)

/** Format integer cents (e.g. 125200) as "$1,252.00" in the venue currency. Returns "—" for null/undefined. */
export function formatMXN(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return MXN.format(cents / 100)
}

/** Format pesos (already-divided floats, e.g. 1252.5) as "$1,252.50".
 *  Used only by `/reports/charts-data` which returns pesos, not cents. */
export function formatMXNFromPesos(pesos: number | null | undefined): string {
  if (pesos == null) return '—'
  return MXN.format(pesos)
}

/** A cost PER UNIT, in cents that may carry decimals (unit_cost_cents is
 *  NUMERIC(14,4) since migration 044). Under $1 it shows up to 4 decimals so a
 *  per-ml or per-gram cost is readable ("$0.0317") instead of "$0.03". */
export function formatUnitCost(cents: number | null | undefined): string {
  if (cents == null) return '—'
  return Math.abs(cents) < 100 ? MXN_PRECISE.format(cents / 100) : MXN.format(cents / 100)
}
