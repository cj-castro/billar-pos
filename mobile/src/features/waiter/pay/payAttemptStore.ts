import { create } from 'zustand';
import { newKey } from '../uuid';

/** One Idempotency-Key per ticket pay attempt, kept (in memory) until the close succeeds so retries replay safely. */
interface PayAttemptState {
  keys: Record<string, string>;
  /** Existing key for the ticket, or a fresh one. */
  keyFor: (ticketId: string) => string;
  clear: (ticketId: string) => void;
}

export const usePayAttemptStore = create<PayAttemptState>((set, get) => ({
  keys: {},
  keyFor: (ticketId) => {
    const existing = get().keys[ticketId];
    if (existing) return existing;
    const key = newKey();
    set((s) => ({ keys: { ...s.keys, [ticketId]: key } }));
    return key;
  },
  clear: (ticketId) =>
    set((s) => {
      const keys = { ...s.keys };
      delete keys[ticketId];
      return { keys };
    }),
}));
