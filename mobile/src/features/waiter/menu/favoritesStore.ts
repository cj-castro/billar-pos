import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** "Frecuentes": per user, one entry per line that was SENT. Local only (no server data), last 30 days. */
export const FAVORITES_DAYS = 30;
export const FAVORITES_MAX = 8;
const DAY_MS = 86_400_000;
const KEEP = 500; // ponytail: hard cap per user; the 30-day prune alone could grow on a busy venue

export interface SentEntry {
  id: string;
  at: number;
}

/** Item ids by number of sent lines (desc), ties by most recent. Entries older than 30 days are ignored. */
export function rankFavorites(entries: readonly SentEntry[], now = Date.now(), limit = FAVORITES_MAX): string[] {
  const agg = new Map<string, { n: number; last: number }>();
  for (const e of entries) {
    if (now - e.at > FAVORITES_DAYS * DAY_MS) continue;
    const a = agg.get(e.id) ?? { n: 0, last: 0 };
    agg.set(e.id, { n: a.n + 1, last: Math.max(a.last, e.at) });
  }
  return [...agg.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last - a[1].last).slice(0, limit).map(([id]) => id);
}

interface FavoritesState {
  byUser: Record<string, SentEntry[]>;
  record: (userId: string, menuItemId: string, now?: number) => void;
}

export const useFavorites = create<FavoritesState>()(
  persist(
    (set) => ({
      byUser: {},
      record: (userId, menuItemId, now = Date.now()) =>
        set((s) => {
          const kept = (s.byUser[userId] ?? []).filter((e) => now - e.at <= FAVORITES_DAYS * DAY_MS);
          return { byUser: { ...s.byUser, [userId]: [...kept, { id: menuItemId, at: now }].slice(-KEEP) } };
        }),
    }),
    { name: 'bola8.waiter.favorites', version: 1, storage: createJSONStorage(() => AsyncStorage), partialize: (s) => ({ byUser: s.byUser }) },
  ),
);
