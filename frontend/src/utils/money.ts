/**
 * Centralized MXN money formatting. Single source of truth — replaces the
 * three duplicated `cents()` / `c()` helpers that lived in ReportsPage,
 * CashSessionPage, and printCashReconciliation.
 *
 * `Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' })`
 * produces the Mexican format: "$1,252.00" with comma thousands separator
 * and period decimal. Always 2 fraction digits, even for whole pesos.
 */

const MXN = new Intl.NumberFormat('es-MX', {
  style: 'currency',
  currency: 'MXN',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Format integer cents (e.g. 125200) as "$1,252.00". Returns "—" for null/undefined. */
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
