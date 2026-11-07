/**
 * MXN formatting, mirrors frontend/src/utils/money.ts ("$1,252.00").
 * Hermes ships Intl on Android/iOS, but currency formatting can be missing or locale-degraded
 * on some builds, so the output is verified once and a manual formatter is used otherwise.
 */

function manual(value: number): string {
  const neg = value < 0;
  const abs = Math.abs(Math.round(value * 100));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}$${grouped}.${frac}`;
}

let intlFormat: ((v: number) => string) | null = null;
try {
  const nf = new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Sanity check: only trust Intl if it reproduces the expected output.
  if (nf.format(1252.5) === '$1,252.50') intlFormat = (v) => nf.format(v);
} catch {
  intlFormat = null;
}

const fmt = (v: number) => (intlFormat ? intlFormat(v) : manual(v));

/** Integer cents (125200) -> "$1,252.00". null/undefined -> "—". */
export function formatMXN(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return fmt(cents / 100);
}

/** Pesos as float (only /reports/charts-data). */
export function formatMXNFromPesos(pesos: number | null | undefined): string {
  if (pesos == null) return '—';
  return fmt(pesos);
}

/** Exposed for tests. */
export const __manualFormat = manual;
