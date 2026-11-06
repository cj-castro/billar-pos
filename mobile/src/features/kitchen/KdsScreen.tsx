import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../components/AppText';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ConnectionPill } from '../../components/ConnectionPill';
import { EmptyState } from '../../components/EmptyState';
import { ErrorState } from '../../components/ErrorState';
import { IconButton } from '../../components/IconButton';
import { KdsTicketCard } from '../../components/KdsTicketCard';
import { LoadingSkeleton } from '../../components/LoadingSkeleton';
import { Logo } from '../../components/Logo';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import type { Station } from '../../domain/types';
import { useCanGoBack } from '../../utils/useCanGoBack';
import { colors, layout, radii, spacing } from '../../theme/tokens';
import { formatClock } from '../../utils/time';
import { useNow } from '../../utils/useNow';
import { useFreshIds, useKdsActions, useKdsQueue, useStaleLive } from './useKds';

export interface KdsScreenProps {
  /** Station locked by role (KITCHEN_STAFF / BAR_STAFF). null/undefined = manager/admin: show the switch. */
  fixedStation?: Station | null;
  /** Embedded in the manager tab bar (bottom inset owned by the tab bar, no "Yo" button). */
  tabs?: boolean;
}

const GAP = spacing.s3;
/** No successful KDS poll for this long while disconnected: advance buttons lock (3 polls of 15 s). */
const KDS_LOCK_AFTER_MS = 45_000;

function StationSwitch({ value, onChange }: { value: Station; onChange: (s: Station) => void }) {
  const { t } = useTranslation('mobile');
  return (
    <View style={styles.switch} accessibilityRole="tablist" accessibilityLabel={t('kitchen.stationSwitch')}>
      {(['KITCHEN', 'BAR'] as const).map((s) => (
        <Pressable
          key={s}
          testID={`station-${s}`}
          accessibilityRole="tab"
          accessibilityLabel={t(`kitchen.station.${s}`)}
          accessibilityState={{ selected: value === s }}
          onPress={() => onChange(s)}
          style={[styles.seg, value === s && styles.segOn]}
        >
          <AppText variant="body" bold color={value === s ? colors.textOnAccent : colors.textSecondary}>
            {t(`kitchen.station.${s}`)}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

function KdsStation({ station, tabs, header }: { station: Station; tabs?: boolean; header: ReactNode }) {
  const { t } = useTranslation('mobile');
  const { width } = useWindowDimensions();
  const q = useKdsQueue(station);
  const fresh = useFreshIds(q.data);
  const actions = useKdsActions(station, q.items);
  const stale = useStaleLive();
  // M8 / US-K-06: connection down AND no successful poll for 3 cycles = stale -> advancing is disabled (reads keep working).
  const clock = useNow(undefined, 5000);
  const locked = stale && (!q.dataUpdatedAt || clock - q.dataUpdatedAt > KDS_LOCK_AFTER_MS);
  const [confirmTicket, setConfirmTicket] = useState<string | null>(null);

  // Portrait phone: one column list. Landscape / tablet: 2-3 column grid.
  const cols = width >= 840 ? 3 : width >= 560 ? 2 : 1;
  const cardWidth = cols === 1 ? undefined : Math.floor((width - spacing.s4 * 2 - GAP * (cols - 1)) / cols) - 1; // -1: pixel snapping must not wrap the last column

  const onAllReady = (ticketId: string) => {
    if (actions.notStarted(ticketId) > 0) setConfirmTicket(ticketId);
    else actions.allReady(ticketId);
  };

  let body: ReactNode;
  if (q.isPending && !q.data) body = <LoadingSkeleton variant="kds" count={3} />;
  else if (q.isError && !q.data) body = <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  else if (q.groups.length === 0)
    body = (
      <EmptyState
        testID="kds-empty"
        icon="check-circle-outline"
        title={t('kitchen.empty')}
        message={`${t('kitchen.emptyHint')} ${q.dataUpdatedAt ? t('kitchen.updatedAt', { time: formatClock(q.dataUpdatedAt) }) : ''}`.trim()}
      />
    );
  else
    body = (
      <ScrollView
        testID="kds-list"
        contentContainerStyle={[styles.grid, { padding: spacing.s4, gap: GAP }]}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => void q.refetch()} tintColor={colors.primary} />}
      >
        {q.groups.map((g) => {
          const isFresh = g.items.some((i) => fresh.has(i.id));
          const allReady = g.items.every((i) => i.status === 'READY');
          return (
            <View
              key={g.ticketId}
              testID={`kds-wrap-${g.ticketId}`}
              style={[styles.cardWrap, cardWidth ? { width: cardWidth } : styles.full, isFresh && styles.fresh, actions.offline && styles.dim]}
            >
              <KdsTicketCard
                ticket={g}
                advancingIds={actions.busy}
                onAdvanceItem={(id) => actions.advance(id)}
                onAllReady={() => onAllReady(g.ticketId)}
                onServed={allReady ? () => actions.serve(g.ticketId) : undefined}
                servedLabel={t('kitchen.served')}
                disabled={locked}
              />
            </View>
          );
        })}
      </ScrollView>
    );

  const banner = (
    <>
      <OfflineBanner />
      {stale && (
        <View testID="kds-stale" accessibilityRole="alert" style={styles.stale}>
          <AppText variant="label" bold color={colors.warning}>
            {t('kitchen.stale')}
          </AppText>
        </View>
      )}
      {q.isError && !!q.data && (
        <View testID="kds-refresh-failed" accessibilityRole="alert" style={styles.errorBanner}>
          <AppText variant="label" bold color={colors.dangerText}>
            {t('kitchen.refreshFailed')}
          </AppText>
        </View>
      )}
    </>
  );

  return (
    <ScreenScaffold testID="screen-kds" padded={false} edges={tabs ? ['top'] : undefined} header={header} banner={banner}>
      {body}
      <ConfirmDialog
        visible={confirmTicket !== null}
        title={t('kitchen.allReadyTitle')}
        message={t('kitchen.allReadyMessage', { n: confirmTicket ? actions.notStarted(confirmTicket) : 0 })}
        confirmLabel={t('kds.allReady')}
        cancelLabel={t('cancel')}
        onConfirm={() => {
          const id = confirmTicket;
          setConfirmTicket(null);
          if (id) actions.allReady(id);
        }}
        onCancel={() => setConfirmTicket(null)}
      />
    </ScreenScaffold>
  );
}

/** SCR-K-01 / SCR-M-04: the kitchen/bar display. */
export function KdsScreen({ fixedStation, tabs }: KdsScreenProps) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const canBack = useCanGoBack();
  const [picked, setPicked] = useState<Station>('KITCHEN');
  const station = fixedStation ?? picked;
  const q = useKdsQueue(station); // same query as KdsStation (shared cache): only feeds the header counter
  const switchable = !fixedStation;

  const right = (
    <View style={styles.right}>
      <ConnectionPill />
      {!tabs && <IconButton icon="account-outline" accessibilityLabel={t('kitchen.menu')} onPress={() => router.push('/kds-me')} testID="kds-menu" />}
    </View>
  );
  const bar = tabs ? (
    <ScreenHeader title={t(`kitchen.station.${station}`)} subtitle={t('kitchen.pending', { n: q.pending })} right={right} />
  ) : (
    <ScreenHeader
      // Back only when pushed (admin/manager from Overview); the kiosk root (kitchen/bar login) has nothing to go back to.
      onBack={canBack ? () => router.back() : undefined}
      leading={
        <Pressable testID="kds-logo" accessibilityRole="button" accessibilityLabel={t('kitchen.menu')} delayLongPress={600} onLongPress={() => router.push('/kds-me')}>
          <Logo size={40} />
        </Pressable>
      }
      title={t(`kitchen.station.${station}`)}
      subtitle={t('kitchen.pending', { n: q.pending })}
      subtitleTestID="kds-pending"
      right={right}
    />
  );

  // Station switch lives on its own row: next to back + logo + pill it left the title ~60 px (crushed to "C...").
  const header = switchable ? (
    <View>
      {bar}
      <View style={styles.switchRow}>
        <StationSwitch value={station} onChange={setPicked} />
      </View>
    </View>
  ) : (
    bar
  );

  return <KdsStation key={station} station={station} tabs={tabs} header={header} />;
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  switchRow: { paddingHorizontal: spacing.s4, paddingBottom: spacing.s2, backgroundColor: colors.surface, alignItems: 'flex-start' },
  switch: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: radii.pill, padding: 2 },
  seg: { minHeight: 40, paddingHorizontal: spacing.s3, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.primary },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
  cardWrap: { borderRadius: radii.lg + 3, borderWidth: 3, borderColor: 'transparent' },
  full: { width: '100%' },
  fresh: { borderColor: colors.primary },
  dim: { opacity: 0.6 },
  stale: { minHeight: layout.statusBannerHeight, justifyContent: 'center', paddingHorizontal: spacing.s4, backgroundColor: colors.warningTint },
  errorBanner: { minHeight: layout.statusBannerHeight, justifyContent: 'center', paddingHorizontal: spacing.s4, backgroundColor: colors.dangerTint },
});
