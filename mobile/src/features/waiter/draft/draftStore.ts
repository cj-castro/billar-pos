import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { newKey } from '../uuid';

/**
 * Local order draft, one list per ticket (D5). Persisted in AsyncStorage so it survives an app restart.
 * `key` is generated ONCE when the line is created and is the Idempotency-Key of its POST (D6): retries
 * reuse it, editing quantity/removing keeps/discards it, so a line can never be created twice.
 */
export type DraftLineState = 'PENDING' | 'SENDING' | 'FAILED';

/** Why a FAILED line failed (drives the copy and whether a global retry includes it). */
export type DraftErrorCode = 'OUT_OF_STOCK' | 'FLAVOR_REQUIRED' | 'INVALID_QUANTITY' | 'NETWORK' | 'SERVER' | 'VERIFY' | 'CONFLICT' | 'UNKNOWN';

export interface DraftModifier {
  id: string;
  name: string;
  priceCents: number;
}

export interface DraftLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
  modifiers: DraftModifier[];
  notes: string;
  state: DraftLineState;
  error?: DraftErrorCode;
  /** e.g. the missing stock item for OUT_OF_STOCK. */
  errorDetail?: string;
  /**
   * X-Ticket-Version sent on this line's FIRST POST (null = no header was sent). `undefined` = never attempted.
   * Without B1 a retry re-sends exactly this version, so a first attempt that landed turns the retry into a 409
   * instead of a duplicate (H1).
   */
  firstAttemptVersion?: number | null;
  addedAt: number;
}

/** Outcome unknown (may already be on the server): the line is locked for editing (H2). */
export const isUncertain = (l: Pick<DraftLine, 'state' | 'error' | 'firstAttemptVersion'>): boolean =>
  l.firstAttemptVersion !== undefined || l.state === 'SENDING' || (l.state === 'FAILED' && (l.error === 'NETWORK' || l.error === 'SERVER' || l.error === 'VERIFY'));

export type NewDraftLine = Pick<DraftLine, 'menuItemId' | 'name' | 'unitPriceCents' | 'quantity' | 'modifiers' | 'notes'>;

export const MAX_QTY = 99;
export const EMPTY_LINES: readonly DraftLine[] = Object.freeze([]);

interface DraftState {
  byTicket: Record<string, DraftLine[]>;
  /** Tickets whose server has answered an add with `ticket_version` (backend B1 deployed). */
  b1Confirmed: Record<string, boolean>;
  markB1: (ticketId: string) => void;
  /** User who owns the drafts; a different user logging in wipes them (SEC-04). */
  ownerId: string | null;
  claimDrafts: (userId: string) => void;
  addLine: (ticketId: string, line: NewDraftLine) => DraftLine;
  setQuantity: (ticketId: string, key: string, quantity: number) => void;
  removeLine: (ticketId: string, key: string) => void;
  patchLine: (ticketId: string, key: string, patch: Partial<DraftLine>) => void;
  clearTicket: (ticketId: string) => void;
  clearAll: () => void;
}

const clampQty = (q: number) => Math.min(MAX_QTY, Math.max(1, Math.floor(q) || 1));
const sameConfig = (a: DraftLine, b: NewDraftLine) =>
  a.menuItemId === b.menuItemId &&
  a.notes.trim() === b.notes.trim() &&
  a.modifiers.map((m) => m.id).sort().join(',') === b.modifiers.map((m) => m.id).sort().join(',');

/**
 * Bumped whenever drafts are wiped for another session (logout / different user). In-flight send runs capture it at
 * start and abort silently when it moves, so a late response never writes to, or posts for, the next user.
 */
let draftEpoch = 0;
export const getDraftEpoch = () => draftEpoch;

export const useDraftStore = create<DraftState>()(
  persist(
    (set, get) => ({
      byTicket: {},
      b1Confirmed: {},
      ownerId: null,
      claimDrafts: (userId) => {
        const { ownerId } = get();
        if (ownerId && ownerId !== userId) {
          draftEpoch++;
          set({ byTicket: {}, b1Confirmed: {}, ownerId: userId });
        } else if (ownerId !== userId) set({ ownerId: userId });
      },
      markB1: (ticketId) => set((s) => (s.b1Confirmed[ticketId] ? s : { b1Confirmed: { ...s.b1Confirmed, [ticketId]: true } })),

      addLine: (ticketId, line) => {
        const lines = get().byTicket[ticketId] ?? [];
        // Same item + options + note on a still-PENDING line: bump its quantity instead of a duplicate row.
        const same = lines.find((l) => l.state === 'PENDING' && l.firstAttemptVersion === undefined && sameConfig(l, line));
        if (same) {
          const merged = { ...same, quantity: clampQty(same.quantity + line.quantity) };
          set({ byTicket: { ...get().byTicket, [ticketId]: lines.map((l) => (l.key === same.key ? merged : l)) } });
          return merged;
        }
        const created: DraftLine = { ...line, quantity: clampQty(line.quantity), notes: line.notes.trim(), key: newKey(), state: 'PENDING', addedAt: Date.now() };
        set({ byTicket: { ...get().byTicket, [ticketId]: [...lines, created] } });
        return created;
      },

      // Uncertain lines are locked (H2): the key may already be on the server, an edit would be silently ignored by a replay.
      setQuantity: (ticketId, key, quantity) =>
        set((s) => ({
          byTicket: { ...s.byTicket, [ticketId]: (s.byTicket[ticketId] ?? []).map((l) => (l.key === key && !isUncertain(l) ? { ...l, quantity: clampQty(quantity) } : l)) },
        })),

      removeLine: (ticketId, key) =>
        set((s) => {
          const next = (s.byTicket[ticketId] ?? []).filter((l) => l.key !== key);
          const byTicket = { ...s.byTicket };
          if (next.length) byTicket[ticketId] = next;
          else delete byTicket[ticketId];
          return { byTicket };
        }),

      patchLine: (ticketId, key, patch) =>
        set((s) => ({
          byTicket: { ...s.byTicket, [ticketId]: (s.byTicket[ticketId] ?? []).map((l) => (l.key === key ? { ...l, ...patch, key: l.key } : l)) },
        })),

      clearTicket: (ticketId) =>
        set((s) => {
          const byTicket = { ...s.byTicket };
          delete byTicket[ticketId];
          return { byTicket };
        }),

      clearAll: () => {
        draftEpoch++;
        set({ byTicket: {}, b1Confirmed: {}, ownerId: null });
      },
    }),
    {
      name: 'bola8.waiter.drafts',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ byTicket: s.byTicket, b1Confirmed: s.b1Confirmed, ownerId: s.ownerId }),
      // A line caught mid-flight by an app kill may or may not have reached the server: never show it as "sending".
      // Keeping the same key makes a retry safe with B1 (server replays) and flags it for the waiter otherwise.
      merge: (persisted, current) => {
        const stored = (persisted as { byTicket?: Record<string, DraftLine[]> } | undefined)?.byTicket ?? {};
        const byTicket: Record<string, DraftLine[]> = {};
        for (const [id, lines] of Object.entries(stored)) {
          if (!Array.isArray(lines) || !lines.length) continue;
          byTicket[id] = lines.map((l) => (l.state === 'SENDING' ? { ...l, state: 'FAILED' as const, error: 'NETWORK' as const } : l));
        }
        const b1Confirmed = (persisted as { b1Confirmed?: Record<string, boolean> } | undefined)?.b1Confirmed ?? {};
        const ownerId = (persisted as { ownerId?: string | null } | undefined)?.ownerId ?? null;
        return { ...current, byTicket, b1Confirmed, ownerId };
      },
    },
  ),
);

export const selectLines = (ticketId: string) => (s: DraftState): readonly DraftLine[] => s.byTicket[ticketId] ?? EMPTY_LINES;

/** Estimated line total (cents) for display only: the server is authoritative (D3). */
export function lineEstimateCents(l: Pick<DraftLine, 'unitPriceCents' | 'quantity' | 'modifiers'>): number {
  return (l.unitPriceCents + l.modifiers.reduce((s, m) => s + m.priceCents, 0)) * l.quantity;
}

export const draftSubtotalCents = (lines: readonly DraftLine[]) => lines.reduce((s, l) => s + lineEstimateCents(l), 0);
