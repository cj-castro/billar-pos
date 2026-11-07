import type { PaymentRow, PeakHourRow, SaleRow, VoidRow } from '../../../../api/endpoints/reports';
import { groupByCategory, hoursFromSeconds, paymentsSummary, peakHours, salesTotal, voidsSummary } from '../reportsModel';

const sale = (category: string, gross: number, disc: number): SaleRow => ({ item_id: category + gross, item_name: 'x', category, routing: 'BAR', units_sold: 1, gross_cents: gross, discounts_cents: disc });

describe('reportsModel', () => {
  const sales = [sale('Cervezas', 10000, 500), sale('Comida', 30000, 0), sale('Cervezas', 5000, 0)];

  it('salesTotal = sum(gross - discounts)', () => {
    expect(salesTotal(sales)).toBe(44500);
    expect(salesTotal([])).toBe(0);
  });

  it('groupByCategory sums per category, sorted desc', () => {
    expect(groupByCategory(sales)).toEqual([
      { category: 'Comida', cents: 30000 },
      { category: 'Cervezas', cents: 14500 },
    ]);
  });

  it('voidsSummary = count + sum(quantity * unit price)', () => {
    const v = (quantity: number, unit_price_cents: number) =>
      ({ ticket_id: 't', table_code: 'T1', item_name: 'i', category: null, quantity, unit_price_cents, reason: null, voided_at: null, voided_by: null, ticket_opened_by: null }) as VoidRow;
    expect(voidsSummary([v(2, 5000), v(1, 2500)])).toEqual({ count: 2, totalCents: 12500 });
  });

  it('peakHours builds 24 buckets and the top-3 by revenue', () => {
    const h = (hour: number, revenue_cents: number): PeakHourRow => ({ hour, ticket_count: 1, revenue_cents, tips_cents: 0, avg_ticket_cents: 0 });
    const { values, top3 } = peakHours([h(20, 900), h(22, 1200), h(21, 1000), h(19, 100), h(23, 0)]);
    expect(values).toHaveLength(24);
    expect(top3).toEqual([22, 21, 20]);
    expect(peakHours([]).top3).toEqual([]);
  });

  it('paymentsSummary uses distinct tickets for the average', () => {
    const p = (total_cents: number, tips_cents: number): PaymentRow => ({ payment_type: 'CASH', ticket_count: 1, total_cents, tips_cents, split_count: 0, unique_tickets: 4, split_tickets: 0 });
    expect(paymentsSummary([p(8000, 500), p(2000, 100)])).toEqual({ tickets: 4, totalCents: 10000, tipsCents: 600, avgCents: 2500 });
    expect(paymentsSummary([]).avgCents).toBeNull();
  });

  it('hoursFromSeconds rounds to 0.1 h', () => {
    expect(hoursFromSeconds(5400)).toBe(1.5);
  });
});
