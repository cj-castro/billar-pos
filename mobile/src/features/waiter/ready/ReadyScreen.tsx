import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toApiError } from '../../../api/client';
import { updateStatus } from '../../../api/endpoints/queue';
import type { QueueItem } from '../../../domain/types';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { useConnectionLevel } from '../../../components/connection';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { useToast } from '../../../components/Toast';
import { colors, radii, spacing } from '../../../theme/tokens';
import { haptic } from '../../../utils/haptics';
import { useReady } from '../queries';
import { ensureNotificationPermission, useAlertPrefs } from './readyAlerts';
import type { ReadyGroup } from './readyEvents';

/** SCR-W-06 Listos: READY lines (kitchen + bar) grouped by table, "Marcar servido" per line / "Servir todo". */
export function ReadyScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const offline = useConnectionLevel() === 'offline';
  const ready = useReady();
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const { model } = ready;

  // iOS asks once, in context (first visit to Listos), not at launch. Android keeps its existing behaviour (Yo toggle).
  useEffect(() => {
    if (Platform.OS === 'ios' && useAlertPrefs.getState().alerts) void ensureNotificationPermission();
  }, []);

  const serve = async (items: QueueItem[]) => {
    setBusy((b) => new Set([...b, ...items.map((i) => i.id)]));
    let failed = false;
    for (const i of items) {
      try {
        await updateStatus(i.id, 'SERVED');
        haptic.success();
      } catch (e) {
        failed = true;
        const err = toApiError(e);
        if (err.status === 409 && err.code === 'ITEM_VOIDED') toast.show({ tone: 'warning', title: t('waiter.ticket.voidedMeanwhile') });
        else toast.show({ tone: 'error', title: t('waiter.ticket.servedFail') });
      }
    }
    setBusy((b) => {
      const next = new Set(b);
      for (const i of items) next.delete(i.id);
      return next;
    });
    await Promise.allSettled([qc.invalidateQueries({ queryKey: ['queue'] }), qc.invalidateQueries({ queryKey: ['ticket'] })]);
    return !failed;
  };

  const refresh = async () => {
    setRefreshing(true);
    await ready.refetch();
    setRefreshing(false);
  };

  const subtitle = model.mineCount === 0 ? t('waiter.ready.subtitleNone') : model.mineCount === 1 ? t('waiter.ready.subtitleOne') : t('waiter.ready.subtitle', { n: model.mineCount });

  let body;
  if (ready.isPending) body = <LoadingSkeleton variant="list" />;
  else if (!ready.hasData) body = <ErrorState error={ready.error} onRetry={refresh} />;
  else if (model.total === 0) body = <EmptyState icon="bell-check-outline" title={t('waiter.ready.emptyTitle')} message={t('waiter.ready.emptyBody')} testID="ready-empty" />;
  else
    body = (
      <ScrollView
        testID="ready-list"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primaryText} colors={[colors.primary]} />}
      >
        {model.mine.length === 0 && (
          <AppText variant="body" color={colors.textSecondary} style={styles.center}>
            {t('waiter.ready.emptyBody')}
          </AppText>
        )}
        {model.mine.map((g) => (
          <Card key={g.ticketId} group={g} busy={busy} offline={offline} onServe={serve} onOpen={() => router.push(`/ticket/${g.ticketId}`)} />
        ))}
        {model.others.length > 0 && (
          <AppText variant="label" bold color={colors.textSecondary} style={styles.sub}>
            {t('waiter.ready.others').toUpperCase()}
          </AppText>
        )}
        {model.others.map((g) => (
          <Card key={g.ticketId} group={g} busy={busy} offline={offline} readOnly onServe={serve} onOpen={() => router.push(`/ticket/${g.ticketId}`)} />
        ))}
      </ScrollView>
    );

  return (
    <ScreenScaffold
      testID="screen-ready"
      edges={['top']}
      padded={false}
      header={<ScreenHeader title={t('tabs.ready')} subtitle={subtitle} right={<ConnectionPill />} />}
      banner={<OfflineBanner />}
    >
      {body}
    </ScreenScaffold>
  );
}

function Card({
  group,
  busy,
  offline,
  readOnly,
  onServe,
  onOpen,
}: {
  group: ReadyGroup;
  busy: ReadonlySet<string>;
  offline: boolean;
  readOnly?: boolean;
  onServe: (items: QueueItem[]) => Promise<boolean>;
  onOpen: () => void;
}) {
  const { t } = useTranslation('mobile');
  const idle = group.items.filter((i) => !busy.has(i.id));
  return (
    <View testID={`ready-card-${group.ticketId}`} style={styles.card}>
      <View style={styles.cardHead}>
        <Pressable accessibilityRole="button" accessibilityLabel={`${group.code}${group.customerName ? `, ${group.customerName}` : ''}`} onPress={onOpen} style={styles.headTitle} hitSlop={8}>
          <AppText variant="title" numberOfLines={1}>
            {group.code}
            {!!group.customerName && (
              <AppText variant="bodyLg" color={colors.textSecondary}>
                {` · ${group.customerName}`}
              </AppText>
            )}
          </AppText>
        </Pressable>
        {!readOnly && group.items.length > 1 && (
          <AppButton label={t('waiter.ready.serveAll', { n: group.items.length })} disabled={offline || idle.length === 0} loading={idle.length === 0} onPress={() => void onServe(group.items)} testID={`ready-serve-all-${group.ticketId}`} />
        )}
      </View>
      {group.items.map((i) => (
        <View key={i.id} testID={`ready-line-${i.id}`} style={styles.line}>
          <View style={styles.lineText}>
            <AppText variant="bodyLg" bold>
              {`${i.quantity}× ${i.menu_item_name}`}
            </AppText>
            <AppText variant="label" color={colors.textSecondary}>
              {[i.modifiers.map((m) => m.name).join(', '), i.routing_dest ? t(`waiter.ready.station.${i.routing_dest}`) : null, i.notes].filter(Boolean).join(' · ')}
            </AppText>
          </View>
          {!readOnly && (
            <AppButton
              label={t('waiter.ready.markServed')}
              variant="success"
              size="lg"
              loading={busy.has(i.id)}
              disabled={offline}
              onPress={() => void onServe([i])}
              testID={`ready-serve-${i.id}`}
              style={styles.serveBtn}
            />
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.s4, gap: spacing.s3, paddingBottom: spacing.s8 },
  center: { textAlign: 'center' },
  sub: { letterSpacing: 0.6, marginTop: spacing.s2 },
  card: { backgroundColor: colors.surfaceRaised, borderRadius: radii.lg, overflow: 'hidden' },
  cardHead: { minHeight: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s2, paddingHorizontal: spacing.s4, paddingVertical: spacing.s2, backgroundColor: colors.surfaceOverlay },
  headTitle: { flex: 1, minHeight: 48, justifyContent: 'center' },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, padding: spacing.s4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  lineText: { flex: 1, gap: 2 },
  serveBtn: { minWidth: 132 },
});
