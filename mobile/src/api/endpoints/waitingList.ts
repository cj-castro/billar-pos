import client from '../client';
import type { Ticket } from '../../domain/types';

export type WaitingStatus = 'WAITING' | 'SEATED' | 'ASSIGNED' | 'CANCELLED' | 'NO_SHOW';

export interface WaitingEntry {
  id: string;
  party_name: string;
  party_size: number;
  notes?: string | null;
  status: WaitingStatus;
  position: number;
  created_at: string;
  wait_seconds?: number | null;
  assigned_resource_code?: string | null;
  assigned_ticket_id?: string | null;
}

/** WAITING + SEATED entries, by position. */
export async function listWaiting(): Promise<WaitingEntry[]> {
  const { data } = await client.get<WaitingEntry[]>('/waiting-list');
  return data;
}

export async function addWaiting(body: { party_name: string; party_size: number; notes?: string }): Promise<WaitingEntry> {
  const { data } = await client.post<WaitingEntry>('/waiting-list', body);
  return data;
}

/** 409 RESOURCE_OCCUPIED / RESOURCE_INACTIVE, 403 BAR_CLOSED. The server names the ticket after the party. */
export async function assignWaiting(id: string, resourceId: string): Promise<{ entry: WaitingEntry; ticket: Ticket }> {
  const { data } = await client.post<{ entry: WaitingEntry; ticket: Ticket }>(`/waiting-list/${id}/assign`, { resource_id: resourceId });
  return data;
}

export async function cancelWaiting(id: string): Promise<void> {
  await client.patch(`/waiting-list/${id}/status`, { status: 'CANCELLED' });
}
