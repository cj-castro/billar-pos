import client from '../client';
import type { CashStatus } from '../../domain/types';

export async function getCashStatus(): Promise<CashStatus> {
  const { data } = await client.get<CashStatus>('/cash/status');
  return data;
}
