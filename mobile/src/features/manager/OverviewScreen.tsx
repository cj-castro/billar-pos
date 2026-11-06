import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../components/AppText';
import { ConnectionPill } from '../../components/ConnectionPill';
import { ErrorState } from '../../components/ErrorState';
import { KdsAgeBadge } from '../../components/KdsAgeBadge';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { SectionHeader } from '../../components/SectionHeader';
import { StatTile } from '../../components/StatTile';
import { useConnectionLevel } from '../../components/connection';
import { useAuthStore } from '../../state/authStore';
import { colors, radii, spacing } from '../../theme/tokens';
import { formatMXN } from '../../utils/money';
import { formatClock } from '../../utils/time';
import type { OverviewAlert } from './overviewModel';
import { usePrintFailures } from './printFailures';
import { useOverview } from './useOverview';

function AlertRow({ alert, onDismiss }: { alert: OverviewAlert; onDismiss?: () => void }) {
  const { t } = useTranslation('mobile');
  const text =
    alert.kind === 'cash_closed'
      ? t('manager.alerts.cashClosed')
      : alert.kind === 'old_items'
        ? t('manager.alerts.oldItems', { count: alert.count, min: 20 })
        : alert.kind === 'ghost'
          ? t('manager.alerts.ghost', { count: alert.count })
          : alert.detail
            ? t('manager.alerts.printFailed', { error: alert.detail })
            : t('manager.alerts.printFailedGeneric');
  const danger = alert.severity === 'alert';
  return (
    <View testID={`alert-${alert.kind}`} accessibilityRole="alert" accessibilityLabel={text} accessible style={[styles.alert, { backgroundColor: danger ? colors.dangerTint : colors.warningTint }]}>
      <MaterialCommunityIcons name={danger ? 'alert-circle-outline' : 'alert-outline'} size={22} color={danger ? colors.dangerText : colors.warning} />
      <AppText variant="body" style={styles.alertText}>
        {text}
      </AppText>
      {onDismiss && (
        <Pressable testID={`alert-dismiss-${alert.failureId}`} accessibilityRole="button" accessibilityLabel={t('manager.alerts.dismiss')} onPress={onDismiss} hitSlop={8} style={styles.dismiss}>
          <MaterialCommunityIcons name="close" size={20} color={colors.textSecondary} />
        </Pressable>
      )}
    </View>
  );
}

/** SCR-M-01 Ops overview. */
export function OverviewScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const level = useConnectionLevel();
  const o = useOverview();
  const dismiss = usePrintFailures((s) => s.dismiss);
  const { stats } = o;
  const stale = level === 'offline';

  // MANAGER has the Cocina/Barra tab; ADMIN reaches the same display through the kitchen group.
  const goKds = () => router.push(role === 'ADMIN' ? '/queue' : '/kds');

  let body;
  if (o.loading) body = <LoadingSkeleton variant="stats" />;
  else if (o.allFailed) body = <ErrorState error={o.firstError} onRetry={() => o.refetch()} />;
  else
    body = (
      <ScrollView
        testID="overview-scroll"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={o.refreshing} onRefresh={() => void o.refetch()} tintColor={colors.primary} />}
      >
        {o.partialError && (
          <View testID="overview-partial-error" accessibilityRole="alert" style={styles.partial}>
            <AppText variant="label" bold color={colors.dangerText}>
              {t('manager.errorBanner')}
            </AppText>
          </View>
        )}

        <View
          testID="cash-card"
          accessible
          accessibilityLabel={stats.cashOpen === false ? `${t('manager.cash.closed')}. ${t('manager.cash.noShift')}` : stats.cashOpen ? t('manager.cash.open') : '—'}
          style={[styles.cash, { backgroundColor: stats.cashOpen === false ? colors.warningTint : colors.surfaceRaised }]}
        >
          <MaterialCommunityIcons name={stats.cashOpen ? 'cash-register' : 'lock-outline'} size={28} color={stats.cashOpen ? colors.success : colors.warning} />
          <View style={styles.flex}>
            <AppText variant="title">{stats.cashOpen == null ? '—' : stats.cashOpen ? t('manager.cash.open') : t('manager.cash.closed')}</AppText>
            <AppText variant="label" color={colors.textSecondary}>
              {stats.cashOpen
                ? [stats.cashOpenedAt ? t('manager.cash.since', { time: formatClock(new Date(stats.cashOpenedAt)) }) : null, stats.fundCents != null ? t('manager.cash.fund', { amount: formatMXN(stats.fundCents) }) : null]
                    .filter(Boolean)
                    .join(' · ')
                : stats.cashOpen === false
                  ? t('manager.cash.noShift')
                  : ''}
            </AppText>
          </View>
        </View>

        <View style={[styles.tiles, stale && styles.stale]}>
          <View style={styles.tileRow}>
            <StatTile testID="tile-open" value={stats.openTickets} label={t('manager.tiles.openTickets')} footnote={stats.openTotalCents != null ? t('manager.tiles.openTotal', { amount: formatMXN(stats.openTotalCents) }) : undefined} onPress={() => router.push('/tickets')} />
            <StatTile testID="tile-bills" value={stats.billRequested} label={t('manager.tiles.bills')} tone={(stats.billRequested ?? 0) > 0 ? 'warning' : 'neutral'} onPress={() => router.push({ pathname: '/tickets', params: { filter: 'bills' } })} />
          </View>
          <View style={styles.tileRow}>
            <StatTile testID="tile-kitchen" value={stats.kitchenCount} label={t('manager.tiles.kitchen')} footnote={t('manager.tiles.inQueue')} onPress={goKds} />
            <StatTile testID="tile-bar" value={stats.barCount} label={t('manager.tiles.bar')} footnote={t('manager.tiles.inQueue')} onPress={goKds} />
          </View>
        </View>

        <View style={styles.oldest} testID="oldest-item">
          <AppText variant="label" color={colors.textSecondary} style={styles.flex}>
            {t('manager.tiles.oldest')}
          </AppText>
          {stats.oldestSentAt ? <KdsAgeBadge since={stats.oldestSentAt} /> : <AppText variant="headline">—</AppText>}
        </View>

        <SectionHeader title={t('manager.alerts.title')} />
        {o.alerts.length === 0 ? (
          <View testID="alerts-none" style={styles.noAlerts}>
            <MaterialCommunityIcons name="check-circle-outline" size={22} color={colors.success} />
            <AppText variant="body" color={colors.textSecondary}>
              {t('manager.alerts.none')}
            </AppText>
          </View>
        ) : (
          o.alerts.map((a) => <AlertRow key={a.id} alert={a} onDismiss={a.failureId ? () => dismiss(a.failureId!) : undefined} />)
        )}
      </ScrollView>
    );

  return (
    <ScreenScaffold testID="screen-overview" padded={false} edges={['top']} header={<ScreenHeader title={t('screens.overview')} right={<ConnectionPill />} />} banner={<OfflineBanner />}>
      {body}
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.s4, gap: spacing.s3 },
  partial: { backgroundColor: colors.dangerTint, borderRadius: radii.md, padding: spacing.s3 },
  cash: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, padding: spacing.s4, borderRadius: radii.lg },
  tiles: { gap: spacing.s3 },
  tileRow: { flexDirection: 'row', gap: spacing.s3 },
  stale: { opacity: 0.7 },
  oldest: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, padding: spacing.s3, borderRadius: radii.lg, backgroundColor: colors.surfaceRaised },
  alert: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, padding: spacing.s3, borderRadius: radii.md },
  alertText: { flex: 1 },
  dismiss: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  noAlerts: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, padding: spacing.s3 },
});
