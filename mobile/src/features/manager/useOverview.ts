import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getCashStatus, getCashSummary } from '../../api/endpoints/cash';
import { listVoids } from '../../api/endpoints/managerOps';
import { listOpenAll, listPendingPayment } from '../../api/endpoints/managerTickets';
import { getCounts, getQueue } from '../../api/endpoints/queue';
import { qk, qkm } from '../../api/queryKeys';

import { useNow } from '../../utils/useNow';
import { MANAGER_POLL_MS, mk } from './keys';
import { mexicoDay } from './mexDate';
import { aggregateOverview, deriveAlerts } from './overviewModel';
import { usePrintFailures } from './printFailures';
import { useRefreshOnEvents } from './useRefreshOnEvents';

const common = { refetchInterval: MANAGER_POLL_MS, staleTime: 10_000 } as const;
/** Money tiles and the voids count: 60 s (plus socket events). */
const slow = { refetchInterval: 60_000, staleTime: 10_000 } as const;

export function useOverview() {
  const cash = useQuery({ queryKey: mk.cashStatus, queryFn: getCashStatus, ...common });
  const openAll = useQuery({ queryKey: mk.openAll, queryFn: listOpenAll, ...common });
  const pending = useQuery({ queryKey: mk.pending, queryFn: listPendingPayment, ...common });
  const counts = useQuery({ queryKey: qk.queueCounts, queryFn: getCounts, ...common });
  const kitchen = useQuery({ queryKey: qk.queue('KITCHEN'), queryFn: () => getQueue('KITCHEN'), ...common });
  const bar = useQuery({ queryKey: qk.queue('BAR'), queryFn: () => getQueue('BAR'), ...common });
  const summary = useQuery({ queryKey: qkm.cashSummary, queryFn: getCashSummary, ...slow });
  const now = useNow(undefined, 30_000);
  const day = mexicoDay(now);
  // Alert-only data: a failure (e.g. 403) just means no alert, never a banner.
  const voids = useQuery({ queryKey: qkm.voidsToday(day), queryFn: () => listVoids(day), ...slow });
  const failures = usePrintFailures((s) => s.items);

  useRefreshOnEvents([mk.cashStatus, mk.openAll, mk.pending, qkm.cashSummary, qkm.voidsToday(day)]);

  const queries = [cash, openAll, pending, counts, kitchen, bar, summary];
  const input = useMemo(
    () => ({
      cash: cash.data,
      openAll: openAll.data,
      pending: pending.data,
      counts: counts.data,
      kitchenQueue: kitchen.data,
      barQueue: bar.data,
      printFailures: failures,
      summary: summary.data,
      voidsToday: voids.data?.length,
    }),
    [cash.data, openAll.data, pending.data, counts.data, kitchen.data, bar.data, failures, summary.data, voids.data],
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
