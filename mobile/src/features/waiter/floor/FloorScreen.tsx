import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../../components/AppText';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { useConnectionLevel } from '../../../components/connection';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { SectionHeader } from '../../../components/SectionHeader';
import { TableCard } from '../../../components/TableCard';
import { useAuthStore } from '../../../state/authStore';
import { colors, radii, spacing, touch } from '../../../theme/tokens';
import { formatMXN } from '../../../utils/money';
import { useCashStatus, usePendingPayment, useResources } from '../queries';
import { deriveFloor, type FloorCard, type FloorKind } from './floorState';

const COLUMNS: Record<FloorKind, number> = { POOL: 2, TABLE: 3, BAR: 3 };

function chunk<T>(list: readonly T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export interface FloorScreenProps {
  /** manager: read-only (no "Abrir mesa"). */
  mode?: 'waiter' | 'manager';
  /** Where a tap on an occupied / bill table goes. Default: the waiter ticket flow. */
  onOpenTicket?: (ticketId: string) => void;
}

/** SCR-W-01 Floor: tables grouped Billar / Mesas / Barra with derived state, pending bills strip, bar-closed banner. */
export function FloorScreen({ mode = 'waiter', onOpenTicket }: FloorScreenProps) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const resources = useResources();
  const pending = usePendingPayment();
  const cash = useCashStatus();
  const level = useConnectionLevel();
  const offline = level === 'offline';
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    await Promise.allSettled([resources.refetch(), pending.refetch(), cash.refetch()]);
    setRefreshing(false);
  };

  const model = resources.data ? deriveFloor(resources.data, pending.data ?? []) : null;
  // `open:false` only when the server said so; unknown (no data yet) never blocks.
  const barClosed = cash.data?.open === false;
  const openTicket = (id: string) => (onOpenTicket ? onOpenTicket(id) : router.push(`/ticket/${id}`));

  const onCard = (c: FloorCard) => {
    if (c.state === 'FREE') {
      if (mode === 'waiter') router.push(`/open-table/${c.resource.id}`);
    } else if (c.ticketId) openTicket(c.ticketId);
  };

  const banners = (
    <View>
      <OfflineBanner />
      {barClosed && (
        <View testID="floor-bar-closed" accessible accessibilityRole="alert" accessibilityLabel={`${t('waiter.floor.barClosed')}. ${t('waiter.floor.barClosedBody')}`} style={styles.closed}>
          <MaterialCommunityIcons name="store-off-outline" size={22} color={colors.warning} />
          <View style={styles.closedText}>
            <AppText variant="body" bold color={colors.warning}>
              {t('waiter.floor.barClosed')}
            </AppText>
            <AppText variant="label" color={colors.textPrimary}>
              {t('waiter.floor.barClosedBody')}
            </AppText>
          </View>
        </View>
      )}
      {resources.isError && !!model && (
        <Pressable testID="floor-refresh-failed" accessibilityRole="button" onPress={refresh} style={styles.errorBanner}>
          <AppText variant="label" bold color={colors.dangerText}>
            {t('waiter.floor.refreshFailed')}
          </AppText>
        </Pressable>
      )}
    </View>
  );

  let body;
  if (!model && resources.isPending) body = <LoadingSkeleton variant="floor" />;
  else if (!model) body = <ErrorState error={resources.error} onRetry={refresh} />;
  else if (model.sections.length === 0)
    body = <EmptyState icon="table-furniture" title={t('waiter.floor.emptyTitle')} message={t('waiter.floor.emptyBody')} testID="floor-empty" />;
  else
    body = (
      <ScrollView
        testID="floor-scroll"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primaryText} colors={[colors.primary]} />}
      >
        {model.pendingBills.length > 0 && (
          <View testID="floor-pending-bills" style={styles.section}>
            <SectionHeader title={t('waiter.floor.pendingBills')} right={<AppText variant="label" color={colors.tableBillFg}>{model.pendingBills.length}</AppText>} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
              {model.pendingBills.map((b) => {
                const code = b.resource_code ?? '—';
                return (
                  <Pressable
                    key={b.id}
                    testID={`floor-pending-${b.id}`}
                    accessibilityRole="button"
                    accessibilityLabel={t('waiter.floor.pendingA11y', { code, total: formatMXN(b.total_cents) })}
                    onPress={() => openTicket(b.id)}
                    style={({ pressed }) => [styles.pending, { opacity: pressed ? 0.85 : 1 }]}
                  >
                    <MaterialCommunityIcons name="bell-outline" size={18} color={colors.tableBillFg} />
                    <AppText variant="bodyLg" bold>
                      {code}
                    </AppText>
                    <AppText variant="label" color={colors.tableBillFg}>
                      {formatMXN(b.total_cents)}
                    </AppText>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        )}
        {model.sections.map((sec) => {
          const cols = COLUMNS[sec.kind];
          const counts = [sec.occupied ? t('waiter.floor.occupiedCount', { n: sec.occupied }) : null, sec.bills ? t('waiter.floor.billCount', { n: sec.bills }) : null].filter(Boolean).join(' · ');
          return (
            <View key={sec.kind} testID={`floor-section-${sec.kind}`} style={styles.section}>
              <SectionHeader title={t(`waiter.floor.section${sec.kind}`)} right={counts ? <AppText variant="label" color={colors.textSecondary}>{counts}</AppText> : undefined} />
              {chunk(sec.cards, cols).map((row, i) => (
                <View key={i} style={styles.row}>
                  {row.map((c) => (
                    <View key={c.resource.id} style={styles.cell}>
                    <TableCard
                      testID={`floor-card-${c.resource.code}`}
                      code={c.resource.code}
                      kind={c.kind}
                      state={c.state}
                      customerName={c.customerName}
                      timerStart={c.timerStart}
                      timerLabel={c.timerStart ? t('waiter.floor.estimated') : undefined}
                      stale={offline}
                      onPress={() => onCard(c)}
                    />
                    </View>
                  ))}
                  {Array.from({ length: cols - row.length }, (_, k) => (
                    <View key={`pad${k}`} style={styles.pad} />
                  ))}
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
    );

  return (
    <ScreenScaffold
      testID="screen-floor"
      edges={['top']}
      padded={false}
      header={<ScreenHeader title={t('tabs.floor')} subtitle={user ? t('waiter.floor.subtitle', { name: user.name }) : undefined} right={<ConnectionPill />} />}
      banner={banners}
    >
      {body}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.s4, gap: spacing.s4, paddingBottom: spacing.s8 },
  section: { gap: spacing.s2 },
  row: { flexDirection: 'row', gap: spacing.s2 },
  pad: { flex: 1 },
  cell: { flex: 1, minWidth: 0 },
  strip: { gap: spacing.s2 },
  pending: {
    minHeight: touch.min,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    paddingHorizontal: spacing.s3,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.tableBillBorder,
    backgroundColor: colors.tableBillBg,
  },
  closed: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, paddingHorizontal: spacing.s4, paddingVertical: spacing.s3, backgroundColor: colors.warningTint },
  closedText: { flex: 1 },
  errorBanner: { minHeight: 36, justifyContent: 'center', paddingHorizontal: spacing.s4, backgroundColor: colors.dangerTint },
});
