import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { listResources } from '../../api/endpoints/resources';
import { listPendingPayment } from '../../api/endpoints/managerTickets';
import { qk } from '../../api/queryKeys';
import { AppText } from '../../components/AppText';
import { ConnectionPill } from '../../components/ConnectionPill';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { SectionHeader } from '../../components/SectionHeader';
import { TableCard } from '../../components/TableCard';
import { useConnectionLevel } from '../../components/connection';
import { colors, spacing } from '../../theme/tokens';
import { ExpressButton, WaitingButton } from '../waiter/floor/FloorHeaderButtons';
import { floorTiles, type FloorKind } from './floorModel';
import { MANAGER_POLL_MS, mk } from './keys';
import { useRefreshOnEvents } from './useRefreshOnEvents';

const SECTIONS: { kind: FloorKind; key: string }[] = [
  { kind: 'POOL', key: 'table.kind.POOL' },
  { kind: 'TABLE', key: 'table.kind.TABLE' },
  { kind: 'BAR', key: 'table.kind.BAR' },
];

/** SCR-M-03: read-only floor (GET /resources + /tickets/pending-payment); an occupied tile opens its ticket. */
export function FloorViewScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const level = useConnectionLevel();
  const res = useQuery({ queryKey: qk.resources, queryFn: () => listResources(), refetchInterval: MANAGER_POLL_MS });
  const pending = useQuery({ queryKey: mk.pending, queryFn: listPendingPayment, refetchInterval: MANAGER_POLL_MS });
  useRefreshOnEvents([qk.resources, mk.pending], ['floor:update', 'ticket:updated']);

  const tiles = floorTiles(res.data ?? [], pending.data ?? []);
  const used = tiles.filter((x) => x.state === 'OCCUPIED' || x.state === 'BILL_REQUESTED').length;
  const active = tiles.filter((x) => x.state !== 'INACTIVE').length;

  let body;
  if (res.isPending && !res.data) body = <LoadingSkeleton variant="floor" />;
  else if (res.isError && !res.data) body = <ErrorState error={res.error} onRetry={() => res.refetch()} />;
  else if (tiles.length === 0) body = <EmptyState testID="floor-empty" icon="table-furniture" title={t('manager.floor.empty')} />;
  else
    body = (
      <ScrollView
        testID="floor-scroll"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={res.isRefetching} onRefresh={() => { res.refetch(); pending.refetch(); }} tintColor={colors.primary} />}
      >
        {SECTIONS.map(({ kind, key }) => {
          const list = tiles.filter((x) => x.kind === kind);
          if (!list.length) return null;
          return (
            <View key={kind}>
              <SectionHeader title={t(key)} />
              <View style={styles.grid}>
                {list.map((x) => (
                  <View key={x.id} style={styles.cell}>
                    <TableCard
                      testID={`floor-tile-${x.code}`}
                      code={x.code}
                      kind={x.kind}
                      state={x.state}
                      bell={x.state === 'BILL_REQUESTED'}
                      customerName={x.customerName}
                      timerStart={x.timerStart}
                      stale={level === 'offline'}
                      onPress={x.ticketId ? () => router.push(`/tickets/${x.ticketId}`) : undefined}
                    />
                  </View>
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>
    );

  return (
    <ScreenScaffold
      testID="screen-floor-view"
      padded={false}
      edges={['top']}
      header={
        <ScreenHeader
          title={t('tabs.floorView')}
          subtitle={t('manager.floor.summary', { used, total: active })}
          leading={<ExpressButton />}
          right={
            <View style={styles.headRight}>
              <WaitingButton />
              <ConnectionPill />
            </View>
          }
        />
      }
      banner={<OfflineBanner />}
    >
      <View style={styles.ro}>
        <AppText variant="caption" color={colors.textMuted}>
          {t('manager.floor.readOnly')}
        </AppText>
      </View>
      {body}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.s4, gap: spacing.s2 },
  headRight: { flexDirection: 'row', alignItems: 'center' },
  ro: { paddingHorizontal: spacing.s4, paddingTop: spacing.s2 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  cell: { width: '31.5%' },
});
