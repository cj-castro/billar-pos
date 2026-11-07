import client from '../client';
import type { DateParams } from './reports';

export interface Earnings {
  ingresos_cents: number;
  cogs_cents: number;
  ganancia_cents: number;
  margen_pct: number | null;
  items_sin_costo_count?: number;
}
export interface EarningsCategoryRow { category: string; ingresos_cents: number; cogs_cents: number; ganancia_cents: number; note?: string }

/** ADMIN only. */
export const getEarnings = async (params: DateParams): Promise<Earnings> => (await client.get<Earnings>('/reports/earnings', { params })).data;
export const getEarningsByCategory = async (params: DateParams): Promise<{ rows: EarningsCategoryRow[] }> =>
  (await client.get('/reports/earnings/by-category', { params })).data;
