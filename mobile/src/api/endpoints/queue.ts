import client from '../client';
import type { QueueItem, Station } from '../../domain/types';

export async function getQueue(station: Station): Promise<QueueItem[]> {
  const { data } = await client.get<QueueItem[]>(station === 'KITCHEN' ? '/queue/kitchen' : '/queue/bar');
  return data;
}

export async function getCounts(): Promise<{ kitchen: number; bar: number }> {
  const { data } = await client.get<{ kitchen: number; bar: number }>('/queue/counts');
  return data;
}

export type QueueTargetStatus = 'IN_PROGRESS' | 'READY' | 'SERVED';

export async function updateStatus(itemId: string, status: QueueTargetStatus): Promise<{ item_id: string; status: string }> {
  const { data } = await client.patch<{ item_id: string; status: string }>(`/queue/${itemId}/status`, { status });
  return data;
}
