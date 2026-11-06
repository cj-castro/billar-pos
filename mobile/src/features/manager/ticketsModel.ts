import type { OpenTicketRow } from '../../api/endpoints/managerTickets';

export type TicketFilter = 'all' | 'bills';

/** Filter + sort of the open-all list. billIds = tickets with "cuenta solicitada" (open-all does not carry the flag). */
export function filterTickets(rows: readonly OpenTicketRow[], billIds: ReadonlySet<string>, filter: TicketFilter): OpenTicketRow[] {
  const list = filter === 'bills' ? rows.filter((r) => billIds.has(r.id)) : [...rows];
  return list.sort((a, b) => (a.opened_at ?? '').localeCompare(b.opened_at ?? ''));
}
