import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toApiError } from '../../../api/client';
import { closeTicket, printReceipt } from '../../../api/endpoints/payments';
import { qk } from '../../../api/queryKeys';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { BottomActionBar } from '../../../components/BottomActionBar';
import { CashPad, type CashPadKey } from '../../../components/CashPad';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { useConnectionLevel } from '../../../components/connection';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState } from '../../../components/ErrorState';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { PinPad } from '../../../components/PinPad';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { useToast } from '../../../components/Toast';
import { useAuthStore } from '../../../state/authStore';
import { colors, radii, spacing } from '../../../theme/tokens';
import { errorMessage } from '../../../utils/errorMessage';
import { haptic } from '../../../utils/haptics';
import { formatMXN } from '../../../utils/money';
import { useResources, useTicketQuery } from '../queries';
import { useClockOffset } from '../../../api/clockSkew';
import { useNow } from '../../../utils/useNow';
import { poolEstimateCents } from '../ticket/poolEstimate';
import { activeTimerStart } from '../ticket/ticketRules';
import { Sheet } from '../ui/Sheet';
import { usePayAttemptStore } from './payAttemptStore';
import { applyPadKey, buildCloseBody, cashChips, classifyCloseError, derive, initialPay, setPart, tipCents, type Method, type PayState, type TipChoice } from './payModel';

type Focus = 'cash' | 'card' | 'tip';
const AUTO_BACK_MS = 3000;
const POOL_TICK_MS = 15_000;
const TIPS: { key: string; tip: TipChoice }[] = [
  { key: 'none', tip: { kind: 'none' } },
  { key: '10', tip: { kind: 'pct', pct: 10 } },
  { key: '15', tip: { kind: 'pct', pct: 15 } },
  { key: '20', tip: { kind: 'pct', pct: 20 } },
];

/** SCR-W-03 Cobrar (DESIGN_SPEC_V2 §2.7). */
export function PayScreen({ ticketId }: { ticketId: string }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const offline = useConnectionLevel() === 'offline';
  const ticketQ = useTicketQuery(ticketId, { refetchOnMount: 'always' });
  const ticket = ticketQ.data;
  const resources = useResources();
  const [raw, setRaw] = useState<PayState>(() => initialPay(false));
  const [focus, setFocus] = useState<Focus>('cash');
  const [confirm, setConfirm] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [done, setDone] = useState<{ change: number } | null>(null);

  const delivery = ticket?.ticket_type === 'DELIVERY';
  const s: PayState = delivery ? { ...raw, method: 'EXTERNAL' } : raw;
  // Pool timer running: the fetched total is stale, so `due` follows the client estimate (refreshed every 15 s). The close body still sends the fetched total.
  const resource = ticket?.resource_id ? resources.data?.find((x) => x.id === ticket.resource_id) : undefined;
  const timerStart = ticket ? activeTimerStart(ticket) : null;
  const cfg = resource?.pool_config;
  const clockOffset = useClockOffset((x) => x.offsetMs);
  const now = useNow(undefined, POOL_TICK_MS, !!timerStart && !!cfg);
  const est =
    timerStart && cfg
      ? poolEstimateCents({ elapsedSeconds: Math.max(0, (now + clockOffset - Date.parse(timerStart)) / 1000), billingMode: cfg.billing_mode, rateCents: cfg.rate_cents, promoFreeMinutes: cfg.promo_free_minutes })
      : null;
  const poolRunning = est !== null;
  const total = ticket?.total_cents ?? 0;
  const shownTotal = ticket && est !== null ? total - ticket.pool_time_cents + est : total;
  const view = derive(shownTotal, s);
  const [tipWarn, setTipWarn] = useState(false);
  const isManager = useAuthStore((st) => st.user?.role === 'MANAGER' || st.user?.role === 'ADMIN');
  // Manager tab group URL is /tickets (matches TicketDetailScreen); waiters return to the floor.
  const goFloor = () => router.replace(isManager ? '/tickets' : '/floor');

  useEffect(() => {
    if (!done) return;
    const id = setTimeout(goFloor, AUTO_BACK_MS);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done, router, isManager]);

  const finish = (change: number) => {
    usePayAttemptStore.getState().clear(ticketId);
    haptic.success();
    setConfirm(false);
    setPinOpen(false);
    setDone({ change });
    void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
    void qc.invalidateQueries({ queryKey: qk.tickets });
    void qc.invalidateQueries({ queryKey: qk.resources });
    void qc.invalidateQueries({ queryKey: qk.cash });
  };

  const pay = useMutation({
    retry: 0,
    mutationFn: (pin?: string) => closeTicket(ticketId, { ...buildCloseBody(total, s), ...(pin ? { manager_pin: pin } : {}) }, usePayAttemptStore.getState().keyFor(ticketId)),
    // Change comes only from the server; never computed locally for the success screen.
    onSuccess: (data) => finish(data.change_due ?? 0),
    onError: async (e) => {
      const err = toApiError(e);
      const kind = classifyCloseError(err);
      if (kind === 'notOpen') {
        haptic.error();
        setConfirm(false);
        setPinOpen(false);
        usePayAttemptStore.getState().clear(ticketId);
        toast.show({ tone: 'error', title: t('errors.title'), message: t('pay.notOpenStatus', { status: String(err.details?.status ?? '?') }) });
        void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
        void qc.invalidateQueries({ queryKey: qk.tickets });
        if (router.canGoBack()) router.back();
        else goFloor();
        return;
      }
      if (kind === 'pinLocked') {
        haptic.error();
        setConfirm(false);
        setPinOpen(false);
        toast.show({ tone: 'error', title: t('errors.title'), message: t('pay.pinLocked') });
        return;
      }
      if (kind === 'pin' || err.code === 'INVALID_PIN') {
        setConfirm(false);
        setPinError(pinOpen ? t('pin.wrong') : null);
        setPinOpen(true);
        return;
      }
      haptic.error();
      setConfirm(false);
      if (kind === 'insufficient' || kind === 'conflict') {
        // Definitive rejection: new body, new attempt key. The refetch shows the server's current total.
        usePayAttemptStore.getState().clear(ticketId);
        const d = err.details;
        // expected_total_cents includes the tip, so only total_cents is the bare total.
        const srvTotal = typeof d?.total_cents === 'number' ? d.total_cents : undefined;
        // Prefer the total the server sent; refetch only as fallback (and to refresh the screen either way).
        const fresh = srvTotal === undefined ? await ticketQ.refetch() : (void ticketQ.refetch(), { data: { total_cents: srvTotal } });
        setRaw((r) => ({ ...r, cashCents: 0, cardCents: 0, last: null }));
        const srv = fresh.data?.total_cents ?? total;
        const tip = s.method === 'EXTERNAL' ? 0 : tipCents(srv, s.tip);
        toast.show({
          tone: 'error',
          title: t('errors.title'),
          message: kind !== 'insufficient' ? t('pay.changed') : tip > 0 ? t('pay.insufficientTip', { total: formatMXN(srv), tip: formatMXN(tip) }) : t('pay.insufficient', { total: formatMXN(srv) }),
        });
      } else if (kind === 'barClosed') toast.show({ tone: 'error', title: t('errors.title'), message: t('pay.barClosed') });
      else toast.show({ tone: 'error', title: t('errors.title'), message: errorMessage(e) });
    },
  });

  const print = useMutation({
    retry: 0,
    mutationFn: () => printReceipt(ticketId),
    onSuccess: () => toast.show({ tone: 'success', title: t('pay.printOk') }),
    onError: () => toast.show({ tone: 'error', title: t('pay.printFail') }),
  });

  const frame = (children: React.ReactNode, footer?: React.ReactNode) => (
    <ScreenScaffold testID="screen-pay" padded={false} footer={footer} header={<ScreenHeader title={t('pay.title')} onBack={done ? goFloor : () => (router.canGoBack() ? router.back() : goFloor())} right={<ConnectionPill />} />} banner={<OfflineBanner />}>
      {children}
    </ScreenScaffold>
  );

  if (!ticket && ticketQ.isPending) return frame(<LoadingSkeleton variant="ticket" />);
  if (!ticket) return frame(<ErrorState error={ticketQ.error} onRetry={() => ticketQ.refetch()} />);

  if (done) {
    const label = ticket.ticket_type === 'TABLE' ? t('pay.closedTable', { code: ticket.resource_code ?? '' }) : ticket.ticket_type === 'EXPRESS' ? t('pay.closedExpress') : t('pay.closedGeneric');
    return frame(
      <View style={styles.success} testID="pay-success">
        <MaterialCommunityIcons name="check-circle" size={96} color={colors.success} />
        <AppText variant="headline" testID="pay-closed-title">
          {label}
        </AppText>
        {done.change > 0 && (
          <View style={styles.center}>
            <AppText variant="label" color={colors.textSecondary}>
              {t('pay.changeDue')}
            </AppText>
            <AppText variant="display" color={colors.success} testID="pay-change-due">
              {formatMXN(done.change)}
            </AppText>
          </View>
        )}
        <AppButton label={t('pay.printReceipt')} variant="secondary" icon="printer-outline" size="lg" fullWidth loading={print.isPending} disabled={offline} onPress={() => print.mutate()} testID="pay-print" />
        <AppButton label={t('pay.backToFloor')} size="lg" fullWidth onPress={goFloor} testID="pay-back" />
      </View>,
    );
  }

  if (ticket.status !== 'OPEN')
    return frame(<EmptyState icon="lock-outline" title={t('pay.notOpen')} action={{ label: t('pay.backToFloor'), onPress: goFloor }} testID="pay-not-open" />);

  const setMethod = (method: Method) => {
    setRaw((r) => ({ ...r, method, cashCents: 0, cardCents: 0, last: null }));
    setFocus('cash');
  };
  const onKey = (k: CashPadKey) => {
    if (focus === 'tip') setRaw((r) => ({ ...r, tip: { kind: 'custom', cents: applyPadKey(r.tip.kind === 'custom' ? r.tip.cents : view.tip, k) } }));
    else if (s.method === 'MIXTO') setRaw((r) => setPart(r, focus, applyPadKey(focus === 'cash' ? view.cash : view.card, k)));
    else setRaw((r) => ({ ...r, cashCents: applyPadKey(r.cashCents, k), last: 'cash' }));
  };

  const showPad = focus === 'tip' ? s.tip.kind === 'custom' : s.method === 'CASH' || s.method === 'MIXTO';
  const reason =
    offline ? t('pay.offline') : view.reason === 'cashLow' ? t('pay.reasonCash', { amount: formatMXN(view.short) }) : view.reason === 'mixedLow' ? t('pay.reasonMixed', { amount: formatMXN(view.due) }) : view.reason === 'mixedParts' ? t('pay.reasonParts') : undefined;
  const amount = formatMXN(view.due);
  const confirmMessage =
    s.method === 'CASH'
      ? t('pay.confirmCash', { amount, change: formatMXN(view.change) })
      : s.method === 'CARD'
        ? t('pay.confirmCard', { amount })
        : s.method === 'MIXTO'
          ? t('pay.confirmMixed', { amount, cash: formatMXN(view.cash), card: formatMXN(view.card), change: formatMXN(view.change) })
          : t('pay.confirmExternal', { amount });
  const breakdown = [
    `${t('waiter.ticket.subtotal')} ${formatMXN(ticket.subtotal_cents)}`,
    ticket.discount_cents > 0 ? `${t('waiter.ticket.discount')} -${formatMXN(ticket.discount_cents)}` : null,
    ticket.pool_time_cents > 0 ? `${t('waiter.ticket.poolTime')} ${formatMXN(ticket.pool_time_cents)}` : null,
    view.tip > 0 ? t('pay.tipAmount', { amount: formatMXN(view.tip) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const footer = (
    <BottomActionBar
      testID="pay-actions"
      helper={reason}
      primary={{ label: t('pay.action', { amount }), onPress: () => (s.tip.kind === 'custom' && view.tip * 2 > shownTotal ? setTipWarn(true) : setConfirm(true)), disabled: !view.valid || offline || pay.isPending, testID: 'pay-submit' }}
    />
  );

  return frame(
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.center}>
          <AppText variant="label" color={colors.textSecondary}>
            {t('pay.totalDue')}
          </AppText>
          <AppText variant="display" testID="pay-due">
            {poolRunning ? `≈ ${amount}` : amount}
          </AppText>
          <AppText variant="caption" color={colors.textMuted} style={styles.centerText} testID="pay-breakdown">
            {breakdown}
          </AppText>
        </View>

        {!delivery && (
          <>
            <Row label={t('pay.tip')}>
              {TIPS.map(({ key, tip }) => (
                <Chip
                  key={key}
                  label={key === 'none' ? t('pay.tipNone') : `${key}%`}
                  on={s.tip.kind === tip.kind && (tip.kind !== 'pct' || (s.tip.kind === 'pct' && s.tip.pct === tip.pct))}
                  onPress={() => setRaw((r) => ({ ...r, tip }))}
                  testID={`pay-tip-${key}`}
                />
              ))}
              <Chip
                label={s.tip.kind === 'custom' ? formatMXN(s.tip.cents) : t('pay.tipOther')}
                on={s.tip.kind === 'custom'}
                onPress={() => {
                  setRaw((r) => ({ ...r, tip: { kind: 'custom', cents: r.tip.kind === 'custom' ? r.tip.cents : 0 } }));
                  setFocus('tip');
                }}
                testID="pay-tip-custom"
              />
            </Row>
            <Row label={t('pay.method')}>
              <Chip label={t('pay.cash')} on={s.method === 'CASH'} onPress={() => setMethod('CASH')} testID="pay-method-cash" />
              <Chip label={t('pay.card')} on={s.method === 'CARD'} onPress={() => setMethod('CARD')} testID="pay-method-card" />
              <Chip label={t('pay.mixed')} on={s.method === 'MIXTO'} onPress={() => setMethod('MIXTO')} testID="pay-method-mixed" />
            </Row>
          </>
        )}

        {s.method === 'EXTERNAL' && (
          <AppText variant="body" color={colors.textSecondary} style={styles.centerText}>
            {t('pay.external')}
          </AppText>
        )}
        {s.method === 'CARD' && (
          <AppText variant="body" color={colors.textSecondary} style={styles.centerText} testID="pay-card-note">
            {t('pay.cardNote', { amount })}
          </AppText>
        )}
        {s.method === 'CASH' && (
          <>
            <Field label={t('pay.received')} cents={s.cashCents} active={focus === 'cash'} onPress={() => setFocus('cash')} testID="pay-cash" />
            <View style={styles.chips}>
              {cashChips(view.due).map((c, i) => (
                <Chip key={c} label={i === 0 ? t('pay.exact') : formatMXN(c)} on={s.cashCents === c} onPress={() => setRaw((r) => ({ ...r, cashCents: c, last: 'cash' }))} testID={i === 0 ? 'pay-exact' : `pay-chip-${c / 100}`} />
              ))}
            </View>
            <Change cents={view.change} label={t('pay.change')} />
          </>
        )}
        {s.method === 'MIXTO' && (
          <>
            <Field label={t('pay.cashPart')} cents={view.cash} active={focus === 'cash'} onPress={() => setFocus('cash')} testID="pay-cash" />
            <Field label={t('pay.cardPart')} cents={view.card} active={focus === 'card'} onPress={() => setFocus('card')} testID="pay-card" />
            <Change cents={view.change} label={t('pay.change')} />
          </>
        )}
        {showPad && <CashPad onKey={onKey} />}
      </ScrollView>

      <ConfirmDialog
        visible={confirm}
        title={t('pay.confirmTitle')}
        message={confirmMessage}
        confirmLabel={t('pay.confirm')}
        cancelLabel={t('cancel')}
        loading={pay.isPending}
        onCancel={() => setConfirm(false)}
        onConfirm={() => pay.mutate(undefined)}
        testID="pay-dialog"
      />
      <ConfirmDialog
        visible={tipWarn}
        title={t('pay.tip')}
        message={t('pay.tipHigh')}
        confirmLabel={t('pay.confirm')}
        cancelLabel={t('cancel')}
        onCancel={() => setTipWarn(false)}
        onConfirm={() => {
          setTipWarn(false);
          setConfirm(true);
        }}
        testID="pay-tip-dialog"
      />
      {pinOpen && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPinOpen(false)} statusBarTranslucent navigationBarTranslucent>
          <Sheet testID="pay-pin-sheet" onClose={pay.isPending ? undefined : () => setPinOpen(false)}>
            <PinPad title={t('pay.pinTitle')} message={t('pay.pinMessage')} error={pinError} loading={pay.isPending} onSubmit={(pin) => pay.mutate(pin)} onCancel={() => setPinOpen(false)} />
          </Sheet>
        </Modal>
      )}
    </>,
    footer,
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.row}>
      <AppText variant="label" bold color={colors.textSecondary}>
        {label}
      </AppText>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

function Chip({ label, on, onPress, testID }: { label: string; on: boolean; onPress: () => void; testID: string }) {
  return <AppButton label={label} variant={on ? 'primary' : 'secondary'} onPress={onPress} testID={testID} style={styles.chip} />;
}

function Field({ label, cents, active, onPress, testID }: { label: string; cents: number; active: boolean; onPress: () => void; testID: string }) {
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={`${label} ${formatMXN(cents)}`} onPress={onPress} style={[styles.field, active && styles.fieldOn]}>
      <AppText variant="label" color={colors.textSecondary}>
        {label}
      </AppText>
      <AppText variant="headline" testID={`${testID}-value`}>
        {formatMXN(cents)}
      </AppText>
    </Pressable>
  );
}

function Change({ cents, label }: { cents: number; label: string }) {
  return (
    <View style={styles.change}>
      <AppText variant="bodyLg" color={colors.textSecondary}>
        {label}
      </AppText>
      <AppText variant="headline" color={cents > 0 ? colors.success : colors.textMuted} testID="pay-change">
        {formatMXN(cents)}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.s4, gap: spacing.s3, paddingBottom: spacing.s6 },
  center: { alignItems: 'center', gap: spacing.s1 },
  centerText: { textAlign: 'center' },
  row: { gap: spacing.s1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  chip: { flexGrow: 1 },
  field: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 56, paddingHorizontal: spacing.s3, borderRadius: radii.md, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surfaceRaised },
  fieldOn: { borderColor: colors.primary },
  change: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  success: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.s4, padding: spacing.s4 },
});
