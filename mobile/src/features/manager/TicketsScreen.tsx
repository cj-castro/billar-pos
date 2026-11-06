import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { listOpenAll, listPendingPayment } from '../../api/endpoints/managerTickets';
import { listTickets } from '../../api/endpoints/tickets';
import { qkm } from '../../api/queryKeys';
import { Chip } from '../../components/Chip';
import { AppText } from '../../components/AppText';
import { ConnectionPill } from '../../components/ConnectionPill';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { StatusChip } from '../../components/StatusChip';
import { colors, radii, spacing } from '../../theme/tokens';
import { formatMXN } from '../../utils/money';
import { useNow } from '../../utils/useNow';
import { MANAGER_POLL_MS, mk } from './keys';
import { finishedRows, openRows, shortId, type TicketFilter, type TicketRow } from './ticketsModel';
import { useRefreshOnEvents } from './useRefreshOnEvents';

/** "12 min" / "1 h 05 min" since an ISO timestamp (opened-at is minutes-scale, not mm:ss). */
export function ageLabel(iso: string | null, now: number): string {
  const start = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(start)) return '';
  const m = Math.max(0, Math.floor((now - start) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function Row({ row, now, onPress }: { row: TicketRow; now: number; onPress: () => void }) {
  const { t } = useTranslation('mobile');
  const code = row.code ?? t('mgr.tickets.express');
  const age = ageLabel(row.at, now);
  const waiter = shortId(row.waiter);
  return (
    <Pressable
      testID={`ticket-row-${row.id}`}
      accessibilityRole="button"
      accessibilityLabel={[code, row.name, row.itemCount != null ? t('manager.tickets.items', { count: row.itemCount }) : null, formatMXN(row.totalCents), row.bill ? t('status.table.BILL_REQUESTED') : null].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={styles.flex}>
        <View style={styles.line}>
          <AppText variant="title">{code}</AppText>
          {row.bill && <StatusChip kind="table" status="BILL_REQUESTED" />}
        </View>
        {!!row.name && (
          <AppText variant="body" color={colors.textSecondary} numberOfLines={1}>
            {row.name}
          </AppText>
        )}
        <AppText variant="label" color={colors.textMuted}>
          {[row.itemCount != null ? t('manager.tickets.items', { count: row.itemCount }) : null, age ? t('mgr.tickets.age', { age }) : null, waiter ? t('mgr.tickets.waiter', { name: waiter }) : null].filter(Boolean).join(' · ')}
        </AppText>
      </View>
      <AppText variant="headline">{formatMXN(row.totalCents)}</AppText>
    </Pressable>
  );
}

/** SCR-M-02 open tickets. */
export function TicketsScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const params = useLocalSearchParams<{ filter?: string }>();
  const [picked, setPicked] = useState<TicketFilter | null>(null);
  // A new ?filter= (tile tap while this tab is mounted) wins over the previous manual choice.
  const [seenParam, setSeenParam] = useState(params.filter);
  if (params.filter !== seenParam) {
    setSeenParam(params.filter);
    setPicked(null);
  }
  const filter: TicketFilter = picked ?? (params.filter === 'bills' ? 'bills' : 'all');
  const now = useNow(undefined, 30_000);

  const finished = filter === 'closed' || filter === 'cancelled';
  const open = useQuery({ queryKey: mk.openAll, queryFn: listOpenAll, refetchInterval: MANAGER_POLL_MS });
  const pending = useQuery({ queryKey: mk.pending, queryFn: listPendingPayment, refetchInterval: MANAGER_POLL_MS });
  // open-all has no waiter; GET /tickets?status=OPEN carries opened_by (best effort, never blocks the list).
  const openFull = useQuery({ queryKey: qkm.ticketsByStatus('OPEN'), queryFn: () => listTickets({ status: 'OPEN' }), refetchInterval: MANAGER_POLL_MS, enabled: !finished });
  const done = useQuery({
    queryKey: qkm.ticketsByStatus(filter === 'cancelled' ? 'CANCELLED' : 'CLOSED'),
    queryFn: () => listTickets({ status: filter === 'cancelled' ? 'CANCELLED' : 'CLOSED' }),
    refetchInterval: MANAGER_POLL_MS,
    enabled: finished,
  });
  useRefreshOnEvents([mk.openAll, mk.pending, qkm.ticketsByStatus('OPEN'), qkm.ticketsByStatus('CLOSED'), qkm.ticketsByStatus('CANCELLED')]);

  const active = finished ? done : open;
  const rows = useMemo(() => {
    if (finished) return finishedRows(done.data ?? [], filter === 'cancelled' ? 'CANCELLED' : 'CLOSED', now);
    const waiters = new Map((openFull.data ?? []).map((x) => [x.id, x.opened_by]));
    return openRows(open.data ?? [], new Set((pending.data ?? []).map((p) => p.id)), waiters, filter === 'bills' ? 'bills' : 'all');
  }, [finished, filter, done.data, open.data, pending.data, openFull.data, now]);

  const emptyTitle = { all: t('manager.tickets.empty'), bills: t('manager.tickets.emptyBills'), closed: t('mgr.tickets.emptyClosed'), cancelled: t('mgr.tickets.emptyCancelled') }[filter];

  let body;
  if (active.isPending && !active.data) body = <LoadingSkeleton variant="list" />;
  else if (active.isError && !active.data) {
    const forbidden = (active.error as { status?: number }).status === 403;
    body = forbidden ? (
      <EmptyState testID="tickets-forbidden" icon="shield-alert-outline" tone="warning" title={t('manager.tickets.forbidden')} />
    ) : (
      <ErrorState error={active.error} onRetry={() => active.refetch()} />
    );
  } else
    body = (
      <FlatList
        testID="tickets-list"
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={rows.length ? styles.list : styles.flex}
        refreshing={active.isRefetching}
        onRefresh={() => {
          active.refetch();
          pending.refetch();
        }}
        ListEmptyComponent={<EmptyState testID="tickets-empty" icon="receipt-text-outline" title={emptyTitle} />}
        renderItem={({ item }) => <Row row={item} now={now} onPress={() => router.push(`/tickets/${item.id}`)} />}
      />
    );

  return (
    <ScreenScaffold testID="screen-tickets" padded={false} edges={['top']} header={<ScreenHeader title={t('screens.tickets')} right={<ConnectionPill />} />} banner={<OfflineBanner />}>
      <View style={styles.chips} accessibilityRole="tablist" accessibilityLabel={t('manager.tickets.filter')}>
        <Chip tab testID="filter-all" label={t('mgr.tickets.open')} on={filter === 'all'} onPress={() => setPicked('all')} />
        <Chip tab testID="filter-bills" label={t('mgr.tickets.bills')} on={filter === 'bills'} onPress={() => setPicked('bills')} />
        <Chip tab testID="filter-closed" label={t('mgr.tickets.closed')} on={filter === 'closed'} onPress={() => setPicked('closed')} />
        <Chip tab testID="filter-cancelled" label={t('mgr.tickets.cancelled')} on={filter === 'cancelled'} onPress={() => setPicked('cancelled')} />
      </View>
      {body}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2, padding: spacing.s4, paddingBottom: spacing.s2 },
  list: { padding: spacing.s4, gap: spacing.s2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 72, padding: spacing.s3, borderRadius: radii.lg, backgroundColor: colors.surfaceRaised },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
});
