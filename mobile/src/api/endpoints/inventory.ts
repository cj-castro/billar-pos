import client from '../client';
import type { StockCheck } from '../../domain/types';

export async function stockCheck(): Promise<StockCheck> {
  const { data } = await client.get<StockCheck>('/inventory/stock-check');
  return data;
}
