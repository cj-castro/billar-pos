/** Pure aggregations over the bare-array /reports/* responses. */
import type { PaymentRow, PeakHourRow, SaleRow, VoidRow } from '../../../api/endpoints/reports';

export const salesTotal = (rows: SaleRow[]) => rows.reduce((s, r) => s + (r.gross_cents - r.discounts_cents), 0);

export function groupByCategory(rows: SaleRow[]): { category: string; cents: number }[] {
  const m = new Map<string, number>();
  for (const r of rows) {
    const k = r.category || '—';
    m.set(k, (m.get(k) ?? 0) + r.gross_cents - r.discounts_cents);
  }
  return [...m.entries()].map(([category, cents]) => ({ category, cents })).sort((a, b) => b.cents - a.cents);
}

export function voidsSummary(rows: VoidRow[]) {
  return { count: rows.length, totalCents: rows.reduce((s, r) => s + r.quantity * r.unit_price_cents, 0) };
}

export function paymentsSummary(rows: PaymentRow[]) {
  // unique_tickets is the same on every row (distinct across methods).
  const tickets = rows[0]?.unique_tickets ?? 0;
  const totalCents = rows.reduce((s, r) => s + r.total_cents, 0);
  return { tickets, totalCents, tipsCents: rows.reduce((s, r) => s + r.tips_cents, 0), avgCents: tickets > 0 ? Math.round(totalCents / tickets) : null };
}

/** 24 revenue buckets + the (up to) 3 busiest hours by revenue. */
export function peakHours(rows: PeakHourRow[]) {
  const values = Array.from({ length: 24 }, () => 0);
  for (const r of rows) if (r.hour >= 0 && r.hour < 24) values[r.hour] += r.revenue_cents;
  const top3 = values
    .map((v, hour) => ({ hour, v }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v || a.hour - b.hour)
    .slice(0, 3)
    .map((x) => x.hour);
  return { values, top3 };
}

export const hoursFromSeconds = (s: number) => Math.round((s / 3600) * 10) / 10;
