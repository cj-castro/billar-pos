import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { OpenTicketRow } from '../../api/endpoints/managerTickets';
import { listOpenAll, listPendingPayment } from '../../api/endpoints/managerTickets';
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
import { filterTickets, type TicketFilter } from './ticketsModel';
import { useRefreshOnEvents } from './useRefreshOnEvents';

/** "12 min" / "1 h 05 min" since an ISO timestamp (opened-at is minutes-scale, not mm:ss). */
export function ageLabel(iso: string | null, now: number): string {
  const start = iso ? new Date(iso).getTime() : NaN;
  if (Number.isNaN(start)) return '';
  const m = Math.max(0, Math.floor((now - start) / 60000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <AppText variant="body" bold color={on ? colors.textOnAccent : colors.textSecondary}>
        {label}
      </AppText>
    </Pressable>
  );
}

function Row({ row, bill, now, onPress }: { row: OpenTicketRow; bill: boolean; now: number; onPress: () => void }) {
  const { t } = useTranslation('mobile');
  const code = row.resource_code ?? t('manager.tickets.noResource');
  const age = ageLabel(row.opened_at, now);
  return (
    <Pressable
      testID={`ticket-row-${row.id}`}
      accessibilityRole="button"
      accessibilityLabel={[code, row.customer_name, t('manager.tickets.items', { count: row.item_count }), formatMXN(row.total_cents), bill ? t('status.table.BILL_REQUESTED') : null].filter(Boolean).join(', ')}
      onPress={onPress}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : 1 }]}
    >
      <View style={styles.flex}>
        <View style={styles.line}>
          <AppText variant="title">{code}</AppText>
          {bill && <StatusChip kind="table" status="BILL_REQUESTED" />}
        </View>
        {!!row.customer_name && (
          <AppText variant="body" color={colors.textSecondary} numberOfLines={1}>
            {row.customer_name}
          </AppText>
        )}
        <AppText variant="label" color={colors.textMuted}>
          {[t('manager.tickets.items', { count: row.item_count }), age ? t('manager.tickets.opened', { age }) : null].filter(Boolean).join(' · ')}
        </AppText>
      </View>
      <AppText variant="headline">{formatMXN(row.total_cents)}</AppText>
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

  const open = useQuery({ queryKey: mk.openAll, queryFn: listOpenAll, refetchInterval: MANAGER_POLL_MS });
  const pending = useQuery({ queryKey: mk.pending, queryFn: listPendingPayment, refetchInterval: MANAGER_POLL_MS });
  useRefreshOnEvents([mk.openAll, mk.pending]);

  const billIds = new Set((pending.data ?? []).map((p) => p.id));
  const rows = filterTickets(open.data ?? [], billIds, filter);

  let body;
  if (open.isPending && !open.data) body = <LoadingSkeleton variant="list" />;
  else if (open.isError && !open.data) {
    const forbidden = (open.error as { status?: number }).status === 403;
    body = forbidden ? (
      <EmptyState testID="tickets-forbidden" icon="shield-alert-outline" tone="warning" title={t('manager.tickets.forbidden')} />
    ) : (
      <ErrorState error={open.error} onRetry={() => open.refetch()} />
    );
  } else
    body = (
      <FlatList
        testID="tickets-list"
        data={rows}
        keyExtractor={(r) => r.id}
        contentContainerStyle={rows.length ? styles.list : styles.flex}
        refreshing={open.isRefetching}
        onRefresh={() => {
          open.refetch();
          pending.refetch();
        }}
        ListEmptyComponent={<EmptyState testID="tickets-empty" icon="receipt-text-outline" title={filter === 'bills' ? t('manager.tickets.emptyBills') : t('manager.tickets.empty')} />}
        renderItem={({ item }) => <Row row={item} bill={billIds.has(item.id)} now={now} onPress={() => router.push(`/tickets/${item.id}`)} />}
      />
    );

  return (
    <ScreenScaffold testID="screen-tickets" padded={false} edges={['top']} header={<ScreenHeader title={t('screens.tickets')} right={<ConnectionPill />} />} banner={<OfflineBanner />}>
      <View style={styles.chips} accessibilityRole="tablist" accessibilityLabel={t('manager.tickets.filter')}>
        <Chip testID="filter-all" label={t('manager.tickets.all')} on={filter === 'all'} onPress={() => setPicked('all')} />
        <Chip testID="filter-bills" label={t('manager.tickets.bills')} on={filter === 'bills'} onPress={() => setPicked('bills')} />
      </View>
      {body}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: 'row', gap: spacing.s2, padding: spacing.s4, paddingBottom: spacing.s2 },
  chip: { minHeight: 44, paddingHorizontal: spacing.s4, borderRadius: radii.pill, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.primary },
  list: { padding: spacing.s4, gap: spacing.s2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 72, padding: spacing.s3, borderRadius: radii.lg, backgroundColor: colors.surfaceRaised },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
});
