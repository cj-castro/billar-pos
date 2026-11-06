import { useEffect } from 'react';
import { create } from 'zustand';
import { onRealtimeEvent } from '../../realtime/socket';

export interface PrintFailure {
  id: string;
  type: string | null;
  error: string | null;
  ticketId: string | null;
  at: number;
}

const MAX = 20;

export const usePrintFailures = create<{ items: PrintFailure[]; add: (f: PrintFailure) => void; dismiss: (id: string) => void; clear: () => void }>((set) => ({
  items: [],
  add: (f) => set((s) => ({ items: [f, ...s.items.filter((i) => i.id !== f.id)].slice(0, MAX) })),
  dismiss: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
}));

/** Socket `print:failed` payload ({job_id, queue_item_id|ticket_id, type, error}) -> store. Only the manager room (B4) receives it. */
export function parsePrintFailed(p: Record<string, unknown> | undefined, now = Date.now()): PrintFailure {
  const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
  const id = str(p?.job_id) ?? str(p?.queue_item_id) ?? `pf-${now}`;
  return { id, type: str(p?.type), error: str(p?.error), ticketId: str(p?.ticket_id), at: now };
}

/** Mount once inside the manager group. */
export function usePrintFailureListener() {
  useEffect(() => onRealtimeEvent('print:failed', (p) => usePrintFailures.getState().add(parsePrintFailed(p))), []);
}
