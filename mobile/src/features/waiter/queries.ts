import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { getCashStatus } from '../../api/endpoints/cash';
import { stockCheck } from '../../api/endpoints/inventory';
import { listCategories, listItems } from '../../api/endpoints/menu';
import { getQueue } from '../../api/endpoints/queue';
import { listResources } from '../../api/endpoints/resources';
import { listPendingPayment } from '../../api/endpoints/ticketOps';
import { getTicket, listTickets } from '../../api/endpoints/tickets';
import { qk } from '../../api/queryKeys';
import { useAuthStore } from '../../state/authStore';
import { buildReadyModel } from './ready/readyEvents';

/**
 * Waiter query keys. Floor-related reads live UNDER `qk.resources` so the shared `floor:update`
 * invalidation (realtime/socket.ts) refreshes them with no change to the shared map.
 */
export const wqk = {
  pendingPayment: [...qk.resources, 'pending-payment'] as const,
  openTickets: [...qk.resources, 'open-tickets'] as const,
  menuCategories: [...qk.menu, 'categories'] as const,
  menuItems: [...qk.menu, 'items'] as const,
};

export const useResources = () => useQuery({ queryKey: qk.resources, queryFn: () => listResources() });
export const usePendingPayment = () => useQuery({ queryKey: wqk.pendingPayment, queryFn: listPendingPayment });
export const useCashStatus = () => useQuery({ queryKey: qk.cash, queryFn: getCashStatus, staleTime: 15_000 });
// A 404 is final (ticket gone): show "no encontrado" at once instead of retrying.
export const useTicketQuery = (id: string) =>
  useQuery({ queryKey: qk.ticket(id), queryFn: () => getTicket(id), staleTime: 5_000, retry: (n, e) => (e as { status?: number }).status !== 404 && n < 1 });

export const MENU_STALE_MS = 5 * 60_000;
export const useMenuCategories = () => useQuery({ queryKey: wqk.menuCategories, queryFn: listCategories, staleTime: MENU_STALE_MS });
export const useMenuItems = () => useQuery({ queryKey: wqk.menuItems, queryFn: () => listItems(), staleTime: MENU_STALE_MS });
export const useStockCheck = () => useQuery({ queryKey: qk.stock, queryFn: stockCheck, staleTime: 30_000 });

/** READY lines of both stations (grouped by ticket), "mine" resolved through the OPEN tickets list (queue rows carry no owner). */
export function useReady() {
  const userId = useAuthStore((s) => s.user?.id);
  const kitchen = useQuery({ queryKey: qk.queue('KITCHEN'), queryFn: () => getQueue('KITCHEN'), staleTime: 10_000 });
  const bar = useQuery({ queryKey: qk.queue('BAR'), queryFn: () => getQueue('BAR'), staleTime: 10_000 });
  const tickets = useQuery({ queryKey: wqk.openTickets, queryFn: () => listTickets({ status: 'OPEN' }), staleTime: 10_000 });
  const items = [...(kitchen.data ?? []), ...(bar.data ?? [])];
  const model = buildReadyModel(items, tickets.data ?? [], userId);
  // READY lines of a ticket we have not loaded yet (a table opened a moment ago): refresh the ticket list once per set.
  const unknown = model.unknownTickets.join(',');
  const refetchTickets = tickets.refetch;
  useEffect(() => {
    if (unknown) void refetchTickets();
  }, [unknown, refetchTickets]);
  const refetch = () => Promise.all([kitchen.refetch(), bar.refetch(), tickets.refetch()]);
  return {
    model,
    isPending: (kitchen.isPending || bar.isPending) && items.length === 0,
    error: kitchen.error ?? bar.error ?? null,
    hasData: kitchen.data !== undefined || bar.data !== undefined,
    isFetching: kitchen.isFetching || bar.isFetching,
    refetch,
  };
}

/** Fresh ticket version for the send orchestrator (bypasses staleTime). */
export function useFetchTicketVersion() {
  const qc = useQueryClient();
  return async (ticketId: string): Promise<number | null> => {
    const t = await qc.fetchQuery({ queryKey: qk.ticket(ticketId), queryFn: () => getTicket(ticketId), staleTime: 0 });
    return typeof t.version === 'number' ? t.version : null;
  };
}
