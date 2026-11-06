import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getCashStatus } from '../../api/endpoints/cash';
import { listOpenAll, listPendingPayment } from '../../api/endpoints/managerTickets';
import { getCounts, getQueue } from '../../api/endpoints/queue';
import { qk } from '../../api/queryKeys';
import { useNow } from '../../utils/useNow';
import { MANAGER_POLL_MS, mk } from './keys';
import { aggregateOverview, deriveAlerts } from './overviewModel';
import { usePrintFailures } from './printFailures';
import { useRefreshOnEvents } from './useRefreshOnEvents';

const common = { refetchInterval: MANAGER_POLL_MS, staleTime: 10_000 } as const;

export function useOverview() {
  const cash = useQuery({ queryKey: mk.cashStatus, queryFn: getCashStatus, ...common });
  const openAll = useQuery({ queryKey: mk.openAll, queryFn: listOpenAll, ...common });
  const pending = useQuery({ queryKey: mk.pending, queryFn: listPendingPayment, ...common });
  const counts = useQuery({ queryKey: qk.queueCounts, queryFn: getCounts, ...common });
  const kitchen = useQuery({ queryKey: qk.queue('KITCHEN'), queryFn: () => getQueue('KITCHEN'), ...common });
  const bar = useQuery({ queryKey: qk.queue('BAR'), queryFn: () => getQueue('BAR'), ...common });
  const failures = usePrintFailures((s) => s.items);
  const now = useNow(undefined, 30_000);

  useRefreshOnEvents([mk.cashStatus, mk.openAll, mk.pending]);

  const queries = [cash, openAll, pending, counts, kitchen, bar];
  const input = useMemo(
    () => ({
      cash: cash.data,
      openAll: openAll.data,
      pending: pending.data,
      counts: counts.data,
      kitchenQueue: kitchen.data,
      barQueue: bar.data,
      printFailures: failures,
    }),
    [cash.data, openAll.data, pending.data, counts.data, kitchen.data, bar.data, failures],
  );
  const stats = useMemo(() => aggregateOverview(input), [input]);
  const alerts = useMemo(() => deriveAlerts(stats, input, now), [stats, input, now]);

  const refetch = () => Promise.all(queries.map((q) => q.refetch()));
  return {
    stats,
    alerts,
    loading: queries.every((q) => q.isPending),
    /** Some (not all) endpoints failed: tiles show "—" and a banner explains. */
    partialError: queries.some((q) => q.isError),
    allFailed: queries.every((q) => q.isError),
    firstError: queries.find((q) => q.isError)?.error,
    refreshing: queries.some((q) => q.isRefetching),
    refetch,
    forbidden: openAll.isError && (openAll.error as { status?: number } | null)?.status === 403,
  };
}
