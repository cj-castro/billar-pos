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
import { TicketLine } from '../../../components/TicketLine';
import { useToast } from '../../../components/Toast';
import { joinTicket, leaveTicket } from '../../../realtime/socket';
import { colors, radii, spacing } from '../../../theme/tokens';
import { ManagerActions } from '../../manager/ManagerActions';
import { errorMessage } from '../../../utils/errorMessage';
import { haptic } from '../../../utils/haptics';
import { formatMXN } from '../../../utils/money';
import { useDraftStore, selectLines } from '../draft/draftStore';
import { useResources, useTicketQuery } from '../queries';
import { TicketExtras, useTicketExtras } from './TicketExtras';
import { TicketHeader, usePoolLive } from './TicketHeader';
import type { ActionRow } from './TicketMoreActions';
import { TicketTotals } from './TicketTotals';
import { activeLines, canCancelTable, canRequestBill, hasTimerSessions, lastRoundLines, lineStatus } from './ticketRules';

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
  const resource = ticket?.resource_id ? resources.data?.find((r) => r.id === ticket.resource_id) : undefined;
  const live = usePoolLive(ticket, resource);
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
  const onPay = () => {
    if (draft.length > 0 && !manager) setDialog('draftBlock');
    else router.push(`/ticket/${ticketId}/pay`);
  };
  /** Copies the newest sent batch into the local draft, then opens it. */
  const repeatRound = () => {
    const rows = ticket ? lastRoundLines(ticket) : [];
    if (rows.length === 0) {
      toast.show({ tone: 'info', title: t('waiter.ticket.repeatNone') });
      return;
    }
    rows.forEach((l) => useDraftStore.getState().addLine(ticketId, l));
    toast.show({ tone: 'success', title: t('waiter.ticket.repeatOk') });
    router.push(`/ticket/${ticketId}/draft`);
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
  const billable = canRequestBill(ticket);
  const payable = activeLines(ticket).length > 0 || hasTimerSessions(ticket);
  const payHelper = !open ? undefined : offline ? t('waiter.ticket.offlinePay') : !payable ? t('waiter.ticket.emptyPay') : undefined;

  const footer = open ? (
    <BottomActionBar
      testID="ticket-actions"
      helper={payHelper}
      primary={{ label: t('waiter.ticket.pay'), onPress: onPay, disabled: offline || !payable, testID: 'ticket-pay' }}
      {...(manager
        ? {}
        : { secondary: { label: t('waiter.ticket.add'), onPress: () => router.push(`/ticket/${ticketId}/menu`), disabled: ticket.payment_requested, testID: 'ticket-add-products' } })}
    />
  ) : undefined;

  const billRow: ActionRow = {
    icon: 'receipt-text-outline',
    label: ticket.payment_requested ? t('waiter.ticket.billAsked') : t('waiter.ticket.requestBill'),
    onPress: onRequestBill,
    disabled: !billable || offline,
    loading: billMutation.isPending,
    testID: 'ticket-request-bill',
  };
  const repeatRow: ActionRow | null = manager ? null : { icon: 'repeat', label: t('waiter.ticket.repeatRound'), onPress: repeatRound, testID: 'ticket-repeat' };
  const cancelRow: ActionRow | null = canCancelTable(ticket)
    ? { icon: 'close-circle-outline', label: t('waiter.ticket.cancelTicket'), danger: true, disabled: offline, onPress: () => setDialog('cancel'), testID: 'ticket-cancel' }
    : null;
  const title = ticket.ticket_type === 'EXPRESS' ? t('waiter.ticket.express', { id: String(ticket.id).slice(-4).toUpperCase() }) : isPool ? t('waiter.ticket.pool', { code }) : t('waiter.ticket.table', { code });

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

        <TicketHeader ticket={ticket} live={live} open={open} />

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

        <TicketTotals ticket={ticket} running={live !== null} />

        {open && <TicketExtras ctl={extras} ticket={ticket} offline={offline} bill={billRow} repeat={repeatRow} cancel={cancelRow} />}

        {/* MANAGER/ADMIN only (the component gates by role itself) */}
        <ManagerActions ticket={ticket} offline={offline} onGone={goBack} />
      </ScrollView>

      <ConfirmDialog
        visible={dialog === 'bill'}
        title={t('waiter.ticket.confirmBillTitle', { code })}
        message={
          isPool
            ? `${t('waiter.ticket.confirmBillBody')} ${t('waiter.ticket.confirmBillPool')}${live ? `
${t('waiter.ticket.poolSummary', { elapsed: live.elapsed, est: live.estimateCents != null ? formatMXN(live.estimateCents) : '—' })}` : ''}`
            : t('waiter.ticket.confirmBillBody')
        }
        confirmLabel={isPool ? t('waiter.ticket.confirmBillPoolStop') : t('waiter.ticket.requestBill')}
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
    title,
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { padding: spacing.s4, gap: spacing.s3, paddingBottom: spacing.s8 },
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
});
