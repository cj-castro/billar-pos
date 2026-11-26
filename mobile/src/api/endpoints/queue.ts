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

/** `expectedFrom` = compare-and-set: the server answers 409 STATUS_CHANGED {current} if the item already moved. */
export async function updateStatus(itemId: string, status: QueueTargetStatus, expectedFrom?: string): Promise<{ item_id: string; status: string }> {
  const { data } = await client.patch<{ item_id: string; status: string }>(`/queue/${itemId}/status`, expectedFrom ? { status, expected_from: expectedFrom } : { status });
  return data;
}
