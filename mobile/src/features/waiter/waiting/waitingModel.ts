import type { Resource } from '../../../domain/types';
import type { WaitingEntry } from '../../../api/endpoints/waitingList';
import { formatElapsed } from '../../../utils/time';

/** "mm:ss" waited so far: the server's `wait_seconds` at fetch time + the time since the fetch (so it ticks without refetching). */
export function waitText(waitSeconds: number | null | undefined, fetchedAt: number, now: number): string {
  const base = Math.max(0, waitSeconds ?? 0);
  return formatElapsed(base + Math.max(0, (now - fetchedAt) / 1000));
}

/** Only WAITING / SEATED entries can be given a table (the list endpoint returns nothing else). */
export const canAssign = (e: Pick<WaitingEntry, 'status'>) => e.status === 'WAITING' || e.status === 'SEATED';

export type TableGroup = 'POOL' | 'TABLE' | 'BAR';
const GROUP: Record<Resource['type'], TableGroup> = { POOL_TABLE: 'POOL', REGULAR_TABLE: 'TABLE', BAR_SEAT: 'BAR' };

/** A table can take a party now: active, AVAILABLE, no open ticket on it (a pool whose bill was requested stays AVAILABLE with a ticket). */
export const isFreeTable = (r: Resource) => r.is_active !== false && r.status === 'AVAILABLE' && !r.active_ticket_id;

/** Free tables grouped Billar / Mesas / Barra (empty groups dropped), natural order inside a group. */
export function freeTablesByGroup(resources: readonly Resource[]): { group: TableGroup; tables: Resource[] }[] {
  const free = resources.filter(isFreeTable).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.code.localeCompare(b.code, 'es', { numeric: true }));
  return (['POOL', 'TABLE', 'BAR'] as const)
    .map((group) => ({ group, tables: free.filter((r) => GROUP[r.type] === group) }))
    .filter((g) => g.tables.length > 0);
}

/** Entries as the list shows them: eligible only, server order (`position`). */
export const visibleEntries = (list: readonly WaitingEntry[]) => list.filter(canAssign).sort((a, b) => a.position - b.position);
