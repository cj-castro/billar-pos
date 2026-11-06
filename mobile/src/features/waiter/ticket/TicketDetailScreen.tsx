import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toApiError } from '../../../api/client';
import { updateStatus } from '../../../api/endpoints/queue';
import { cancelTicket } from '../../../api/endpoints/ticketOps';
import { requestPayment } from '../../../api/endpoints/tickets';
import { qk } from '../../../api/queryKeys';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { BottomActionBar } from '../../../components/BottomActionBar';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { useConnectionLevel } from '../../../components/connection';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { StatusChip } from '../../../components/StatusChip';
import { TicketLine } from '../../../components/TicketLine';
import { useToast } from '../../../components/Toast';
import { joinTicket, leaveTicket } from '../../../realtime/socket';
import { colors, radii, spacing } from '../../../theme/tokens';
import { errorMessage } from '../../../utils/errorMessage';
import { haptic } from '../../../utils/haptics';
import { formatMXN } from '../../../utils/money';
import { formatClock, useElapsed } from '../../../utils/time';
import { useDraftStore, selectLines } from '../draft/draftStore';
import { useResources, useTicketQuery } from '../queries';
import { activeTimerStart, canCancelTable, canRequestBill, hasTimerSessions, lineStatus } from './ticketRules';
import { TicketExtras, useTicketExtras } from './TicketExtras';

export type TicketMode = 'waiter' | 'manager';

export interface TicketDetailScreenProps {
  ticketId: string;
  /** manager: no "Agregar productos"; long-press lines for manager-only actions (void, discount). */
  mode: TicketMode;
}

const lineModifiers = (l: { modifiers: { name: string }[] }) => l.modifiers.map((m) => m.name);

/** SCR-W-02 Ticket detail (also rendered by the manager group in `mode="manager"`). */
export function TicketDetailScreen({ ticketId, mode }: TicketDetailScreenProps) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const manager = mode === 'manager';
  const offline = useConnectionLevel() === 'offline';
  const ticketQ = useTicketQuery(ticketId);
  const resources = useResources();
  const draft = useDraftStore(selectLines(ticketId));
  const [dialog, setDialog] = useState<null | 'bill' | 'cancel' | 'draftBlock'>(null);
  const [servingId, setServingId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const extras = useTicketExtras(ticketId, mode);

  // Realtime: live ticket updates only while this screen is focused (matrix W-02).
  useFocusEffect(
    useCallback(() => {
      joinTicket(ticketId);
      return () => leaveTicket(ticketId);
    }, [ticketId]),
  );

  const ticket = ticketQ.data;
  const timerStart = ticket ? activeTimerStart(ticket) : null;
  const elapsed = useElapsed(timerStart);
  const resource = ticket?.resource_id ? resources.data?.find((r) => r.id === ticket.resource_id) : undefined;
  const isPool = resource?.type === 'POOL_TABLE' || (!!ticket && hasTimerSessions(ticket));

  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace(manager ? '/tickets' : '/floor');
  };
  const refresh = async () => {
    setRefreshing(true);
    await ticketQ.refetch();
    setRefreshing(false);
  };
  const resync = () => {
    void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
    void qc.invalidateQueries({ queryKey: qk.resources });
  };

  const billMutation = useMutation({
    retry: 0,
    mutationFn: () => requestPayment(ticketId),
    onSuccess: () => {
      haptic.success();
      toast.show({ tone: 'success', title: t('waiter.ticket.billOk') });
      resync();
    },
    onError: async (billErr) => {
      // Unknown outcome after a network loss: if the server did record it, treat it as success.
      const fresh = await ticketQ.refetch();
      if (fresh.data?.payment_requested) {
        haptic.success();
        toast.show({ tone: 'success', title: t('waiter.ticket.billOk') });
      } else {
        haptic.error();
        toast.show({ tone: 'error', title: t('errors.title'), message: errorMessage(billErr) });
      }
      resync();
    },
  });

  const cancelMutation = useMutation({
    retry: 0,
    mutationFn: () => cancelTicket(ticketId),
    onSuccess: () => {
      haptic.success();
      toast.show({ tone: 'success', title: t('waiter.ticket.cancelOk') });
      resync();
      if (manager) goBack();
      else router.replace('/floor');
    },
    onError: (e) => {
      const err = toApiError(e);
      haptic.error();
      const msg = err.code === 'HAS_ITEMS' ? t('waiter.ticket.cancelHasItems') : err.code === 'HAS_POOL_TIME' ? t('waiter.ticket.cancelHasPool') : errorMessage(e);
      toast.show({ tone: 'error', title: t('errors.title'), message: msg });
      resync();
    },
  });

  const serveMutation = useMutation({
    retry: 0,
    mutationFn: (itemId: string) => updateStatus(itemId, 'SERVED'),
    onMutate: (itemId) => setServingId(itemId),
    onSuccess: () => {
      haptic.success();
      resync();
      void qc.invalidateQueries({ queryKey: ['queue'] });
    },
    onError: (e) => {
      const err = toApiError(e);
      toast.show({ tone: 'error', title: err.code === 'ITEM_VOIDED' ? t('waiter.ticket.voidedMeanwhile') : t('waiter.ticket.servedFail') });
      resync();
    },
    onSettled: () => setServingId(null),
  });

  const onRequestBill = () => {
    if (draft.length > 0) setDialog('draftBlock');
    else setDialog('bill');
  };

  // ------------------------------------------------------------------ states
  const frame = (children: React.ReactNode, footer?: React.ReactNode, title?: string) => (
    <ScreenScaffold
      testID="screen-ticket"
      padded={false}
      footer={footer}
      header={<ScreenHeader title={title ?? t('screens.ticket')} onBack={goBack} right={<ConnectionPill />} />}
      banner={<OfflineBanner />}
    >
      {children}
    </ScreenScaffold>
  );

  if (!ticket && ticketQ.isPending) return frame(<LoadingSkeleton variant="ticket" />);
  if (!ticket) {
    const err = ticketQ.error ? toApiError(ticketQ.error) : null;
    if (err?.status === 404)
      return frame(
        <EmptyState
          icon="magnify"
          title={t('waiter.ticket.notFound')}
          action={{ label: t('waiter.ticket.backToFloor'), onPress: () => router.replace(manager ? '/tickets' : '/floor') }}
          testID="ticket-not-found"
        />,
      );
    return frame(<ErrorState error={ticketQ.error} onRetry={() => ticketQ.refetch()} />);
  }

  const open = ticket.status === 'OPEN';
  const code = ticket.resource_code ?? '—';
  const lines = ticket.line_items ?? [];
  const subtitle = [ticket.customer_name, t('waiter.ticket.openedAt', { time: formatClock(new Date(ticket.opened_at)) })].filter(Boolean).join(' · ');
  const stateChip = ticket.payment_requested ? 'BILL_REQUESTED' : 'OCCUPIED';
  const billable = canRequestBill(ticket);
  const billHelper = !open ? undefined : offline ? t('waiter.ticket.offlineBill') : !billable && !ticket.payment_requested ? t('waiter.ticket.emptyBill') : undefined;
  const hasRunningTimer = !!timerStart;

  const footer = open ? (
    <BottomActionBar
      testID="ticket-actions"
      helper={billHelper}
      {...(manager
        ? { primary: { label: ticket.payment_requested ? t('waiter.ticket.billRequested') : t('waiter.ticket.requestBill'), onPress: onRequestBill, disabled: !billable || offline, loading: billMutation.isPending, testID: 'ticket-request-bill' } }
        : {
            primary: { label: t('waiter.ticket.addProducts'), onPress: () => router.push(`/ticket/${ticketId}/menu`), disabled: ticket.payment_requested, testID: 'ticket-add-products' },
            secondary: {
              label: ticket.payment_requested ? t('waiter.ticket.billAsked') : t('waiter.ticket.requestBill'),
              onPress: onRequestBill,
              disabled: !billable || offline,
              loading: billMutation.isPending,
              testID: 'ticket-request-bill',
            },
          })}
    />
  ) : undefined;

  return frame(
    <>
      <ScrollView
        testID="ticket-scroll"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primaryText} colors={[colors.primary]} />}
      >
        {!open && (
          <View testID="ticket-closed" accessibilityRole="alert" style={styles.closedBanner}>
            <MaterialCommunityIcons name="lock-outline" size={20} color={colors.warning} />
            <View style={styles.flex}>
              <AppText variant="body" bold color={colors.warning}>
                {t('waiter.ticket.closedTitle')}
              </AppText>
              <AppText variant="label">{t('waiter.ticket.closedBody')}</AppText>
            </View>
          </View>
        )}

        <View style={styles.hero}>
          <View style={styles.flex}>
            {hasRunningTimer ? (
              <>
                <AppText variant="label" color={colors.textSecondary}>
                  {`${t('waiter.ticket.poolTime')} · ${t('waiter.ticket.estimated')}`}
                </AppText>
                <AppText variant="timer" testID="ticket-timer">
                  {elapsed}
                </AppText>
              </>
            ) : (
              <>
                <AppText variant="label" color={colors.textSecondary}>
                  {subtitle}
                </AppText>
                <AppText variant="headline" testID="ticket-hero-total">
                  {formatMXN(ticket.total_cents)}
                </AppText>
              </>
            )}
          </View>
          {open && <StatusChip kind="table" status={stateChip} size="lg" testID="ticket-state" />}
        </View>

        {open && draft.length > 0 && !manager && (
          <Pressable
            testID="ticket-draft-bar"
            accessibilityRole="button"
            accessibilityLabel={`${draft.length === 1 ? t('waiter.ticket.draftBarOne') : t('waiter.ticket.draftBar', { n: draft.length })}. ${t('waiter.ticket.review')}`}
            onPress={() => router.push(`/ticket/${ticketId}/draft`)}
            style={styles.draftBar}
          >
            <MaterialCommunityIcons name="clock-outline" size={20} color={colors.warning} />
            <AppText variant="body" bold color={colors.warning} style={styles.flex}>
              {draft.length === 1 ? t('waiter.ticket.draftBarOne') : t('waiter.ticket.draftBar', { n: draft.length })}
            </AppText>
            <AppText variant="body" bold color={colors.warning}>
              {`${t('waiter.ticket.review')} ›`}
            </AppText>
          </Pressable>
        )}

        {lines.length === 0 ? (
          <View style={styles.empty} testID="ticket-empty">
            <EmptyState icon="silverware-fork-knife" title={t('waiter.ticket.emptyTitle')} message={manager ? undefined : t('waiter.ticket.emptyBody')} />
          </View>
        ) : (
          <View style={styles.lines} testID="ticket-lines">
            {lines.map((l) => (
              <View key={l.id} style={styles.lineWrap}>
                <TicketLine
                  testID={`ticket-line-${l.id}`}
                  quantity={l.quantity}
                  name={l.menu_item_name}
                  modifiers={lineModifiers(l)}
                  note={l.notes}
                  status={lineStatus(l)}
                  netCents={l.net_cents}
                  promoLabel={l.promo_discount_cents > 0 ? `-${formatMXN(l.promo_discount_cents)}` : null}
                  onLongPress={open ? () => extras.openLineActions(l) : undefined}
                />
                {l.status === 'READY' && open && (
                  <AppButton
                    label={t('waiter.ticket.markServed')}
                    variant="success"
                    icon="check-all"
                    fullWidth
                    loading={servingId === l.id}
                    disabled={offline || (servingId !== null && servingId !== l.id)}
                    onPress={() => serveMutation.mutate(l.id)}
                    testID={`ticket-serve-${l.id}`}
                  />
                )}
              </View>
            ))}
          </View>
        )}

        <View style={styles.totals} testID="ticket-totals">
          <TotalRow label={t('waiter.ticket.subtotal')} value={formatMXN(ticket.subtotal_cents)} testID="ticket-subtotal" />
          {ticket.discount_cents > 0 && <TotalRow label={t('waiter.ticket.discount')} value={`-${formatMXN(ticket.discount_cents)}`} color={colors.success} testID="ticket-discount" />}
          {(ticket.pool_time_cents > 0 || hasRunningTimer) && (
            <TotalRow
              label={`${t('waiter.ticket.poolTime')}${hasRunningTimer ? ` (${t('waiter.ticket.estimated')})` : ''}`}
              value={`${hasRunningTimer ? '≈ ' : ''}${formatMXN(ticket.pool_time_cents)}`}
              color={hasRunningTimer ? colors.warning : undefined}
              testID="ticket-pool"
            />
          )}
          <TotalRow label={t('waiter.ticket.total')} value={formatMXN(ticket.total_cents)} bold testID="ticket-total" />
          <AppText variant="caption" color={colors.textMuted}>
            {t('waiter.ticket.serverNote')}
          </AppText>
        </View>

        {open && canCancelTable(ticket) && (
          <AppButton label={t('waiter.ticket.cancelTable')} variant="dangerOutline" icon="close-circle-outline" onPress={() => setDialog('cancel')} disabled={offline} testID="ticket-cancel" />
        )}
        {open && <TicketExtras ctl={extras} ticket={ticket} offline={offline} />}
      </ScrollView>

      <ConfirmDialog
        visible={dialog === 'bill'}
        title={t('waiter.ticket.confirmBillTitle', { code })}
        message={isPool ? `${t('waiter.ticket.confirmBillBody')} ${t('waiter.ticket.confirmBillPool')}` : t('waiter.ticket.confirmBillBody')}
        confirmLabel={t('waiter.ticket.requestBill')}
        cancelLabel={t('cancel')}
        loading={billMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          billMutation.mutate(undefined, { onSettled: () => setDialog(null) });
        }}
        testID="bill-dialog"
      />
      <ConfirmDialog
        visible={dialog === 'cancel'}
        title={t('waiter.ticket.cancelTitle', { code })}
        message={t('waiter.ticket.cancelBody')}
        confirmLabel={t('waiter.ticket.cancelTable')}
        cancelLabel={t('cancel')}
        destructive
        loading={cancelMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          cancelMutation.mutate(undefined, { onSettled: () => setDialog(null) });
        }}
        testID="cancel-dialog"
      />
      <ConfirmDialog
        visible={dialog === 'draftBlock'}
        title={t('waiter.ticket.draftBlockTitle')}
        message={t('waiter.ticket.draftBlockBody', { n: draft.length })}
        confirmLabel={t('waiter.ticket.reviewOrder')}
        cancelLabel={t('close')}
        onCancel={() => setDialog(null)}
        onConfirm={() => {
          setDialog(null);
          router.push(`/ticket/${ticketId}/draft`);
        }}
        testID="draft-block-dialog"
      />
    </>,
    footer,
    isPool ? t('waiter.ticket.pool', { code }) : t('waiter.ticket.table', { code }),
  );
}

function TotalRow({ label, value, bold, color, testID }: { label: string; value: string; bold?: boolean; color?: string; testID?: string }) {
  return (
    <View style={styles.totalRow}>
      <AppText variant={bold ? 'bodyLg' : 'body'} bold={bold} color={color ?? (bold ? colors.textPrimary : colors.textSecondary)}>
        {label}
      </AppText>
      <AppText variant={bold ? 'bodyLg' : 'body'} bold={bold} color={color} testID={testID}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.s4, gap: spacing.s3, paddingBottom: spacing.s8 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 64 },
  draftBar: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s2,
    paddingHorizontal: spacing.s3,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: colors.warning,
    backgroundColor: colors.warningTint,
  },
  closedBanner: { flexDirection: 'row', gap: spacing.s3, padding: spacing.s3, borderRadius: radii.md, backgroundColor: colors.warningTint },
  empty: { minHeight: 220 },
  lines: { gap: spacing.s2 },
  lineWrap: { gap: spacing.s1 },
  totals: { gap: spacing.s1, paddingVertical: spacing.s3, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
});
