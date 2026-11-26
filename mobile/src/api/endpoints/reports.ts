import client from '../client';

export interface DateParams {
  from: string;
  to: string;
}
export interface SaleRow { item_id: string; item_name: string; category: string; routing: string; units_sold: number; gross_cents: number; discounts_cents: number }
export interface PoolTimeRow { table_code: string; sessions: number; total_seconds: number; revenue_cents: number }
export interface PromotionRow { promotion_id: string; promotion_name: string; promo_type: string; tickets_count: number; applications: number; units_discounted: number; gross_cents: number; discount_cents: number; net_cents: number }
export interface PaymentRow { payment_type: string; ticket_count: number; total_cents: number; tips_cents: number; split_count: number; unique_tickets: number; split_tickets: number }
export interface VoidRow { ticket_id: string; table_code: string | null; item_name: string; category: string | null; quantity: number; unit_price_cents: number; reason: string | null; voided_at: string | null; voided_by: string | null; ticket_opened_by: string | null }
export interface StaffRow { user_id: string; staff_name: string; role: string; tickets_opened: number; tickets_closed: number; total_sales_cents: number; total_tips_cents: number; cash_sales_cents: number; card_sales_cents: number }
export interface PeakHourRow { hour: number; ticket_count: number; revenue_cents: number; tips_cents: number; avg_ticket_cents: number }

const get = async <T>(path: string, params?: DateParams): Promise<T> => (await client.get<T>(path, { params })).data;

export const getSales = (p: DateParams) => get<SaleRow[]>('/reports/sales', p);
export const getPoolTime = (p: DateParams) => get<PoolTimeRow[]>('/reports/pool-time', p);
export const getPromotions = (p: DateParams) => get<PromotionRow[]>('/reports/promotions', p);
export const getPayments = (p: DateParams) => get<PaymentRow[]>('/reports/payments', p);
export const getVoids = (p: DateParams) => get<VoidRow[]>('/reports/voids', p);
export const getStaff = (p: DateParams) => get<StaffRow[]>('/reports/staff', p);
export const getPeakHours = (p: DateParams) => get<PeakHourRow[]>('/reports/peak-hours', p);

/** CSV text of the sales report. */
export async function exportSalesCsv(p: DateParams): Promise<string> {
  const { data } = await client.get<string>('/reports/export', { params: { ...p, type: 'sales', format: 'csv' }, responseType: 'text', transformResponse: (d) => d });
  return data;
}

// ponytail: cash.ts is owned by another agent, so sessions live here. GET /cash/sessions = last 30 (MANAGER/ADMIN).
