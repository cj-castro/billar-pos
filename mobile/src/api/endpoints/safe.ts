import client from '../client';
import type { DateParams } from './reports';

export interface SafeEntry { id: string; amount_cents: number; notes: string | null; created_at: string; collector_name: string | null; collector_username: string | null }

/** ADMIN only. */
export const listSafe = async (params: DateParams): Promise<SafeEntry[]> => (await client.get<SafeEntry[]>('/safe', { params })).data;
export const createSafe = async (body: { amount_cents: number; notes: string }) => (await client.post('/safe', body)).data;
export const deleteSafe = async (id: string) => (await client.delete(`/safe/${id}`)).data;
