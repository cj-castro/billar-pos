import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toApiError } from '../../api/client';
import { decidePromotion, editPayment, editTimer, forceClose, getEditHistory, reopenTicket, reprintTicket, voidTimer } from '../../api/endpoints/managerOps';
import { qk, qkm } from '../../api/queryKeys';

import { AppText } from '../../components/AppText';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { PinPad } from '../../components/PinPad';
import { useToast } from '../../components/Toast';
import type { Ticket } from '../../domain/types';
import { useAuthStore } from '../../state/authStore';
import { colors, radii, spacing } from '../../theme/tokens';
import { errorMessage } from '../../utils/errorMessage';
import { haptic } from '../../utils/haptics';
import { SheetModal } from '../common/SheetModal';
import { TicketMoreActions, type ActionRow } from '../waiter/ticket/TicketMoreActions';
import { actionErrorKey, activeTimer, managerActionFlags, paymentFields, promoOffers, timerSessions } from './managerActionsModel';
import { mexicoClock } from './mexDate';
import { PaymentEditSheet, PromoSheet, ReasonSheet, TimerSheet } from './ManagerSheets';

type Flow = null | 'forceClose' | 'reopen' | 'editPayment' | 'editPaymentPin' | 'promos' | 'reprint' | 'voidTimer' | 'editTimer';
/** Errors the sheet can correct and retry: keep it open. */
const RETRYABLE = new Set(['REASON_REQUIRED', 'NO_CHANGES', 'INVALID_TIME_RANGE', 'INVALID_TIMESTAMP']);

/** "Acciones de gerente" for MANAGER/ADMIN in the ticket detail. Void-line lives in TicketExtras; the server stays the authority. */
export function ManagerActions({ ticket, offline, onGone }: { ticket: Ticket; offline: boolean; onGone: () => void }) {
  const { t } = useTranslation('mobile');
  const qc = useQueryClient();
  const toast = useToast();
  const user = useAuthStore((s) => s.user);
  const flags = managerActionFlags(ticket, user?.role);
  const [flow, setFlow] = useState<Flow>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ body: Record<string, unknown>; reason: string } | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [timerError, setTimerError] = useState<string | null>(null);

  const history = useQuery({
    queryKey: qkm.editHistory(ticket.id),
    queryFn: () => getEditHistory(ticket.id),
    enabled: ticket.status === 'CLOSED' && !!paymentFields(ticket).edited_after_close && flags.editPayment,
  });

  if (!user || !Object.values(flags).some(Boolean)) return null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.ticket(ticket.id) });
    void qc.invalidateQueries({ queryKey: qk.resources });
    void qc.invalidateQueries({ queryKey: qk.tickets });
    void qc.invalidateQueries({ queryKey: qk.cash });
  };
  const close = () => {
    setFlow(null);
    setPending(null);
    setPinError(null);
    setTimerError(null);
  };
  const message = (e: unknown) => {
    const key = actionErrorKey(toApiError(e).code);
    return key ? t(`mgr.actions.errors.${key}`) : errorMessage(e);
  };

  /** Runs one call; success closes the flow, a conflict toasts and closes unless the sheet can fix it. */
  const run = async (fn: () => Promise<unknown>, okTitle: string | ((r: unknown) => string), after?: (r: unknown) => void) => {
    setBusy(true);
    try {
      const r = await fn();
      haptic.success();
      toast.show({ tone: 'success', title: typeof okTitle === 'function' ? okTitle(r) : okTitle });
      refresh();
      close();
      after?.(r);
    } catch (e) {
      haptic.error();
      const msg = message(e);
      if (flow === 'editTimer') setTimerError(msg);
      toast.show({ tone: 'error', title: t('errors.title'), message: msg });
      if (!RETRYABLE.has(toApiError(e).code)) {
        refresh();
        if (flow !== 'editTimer') close();
      }
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async (pin: string) => {
    if (!pending) return;
    setBusy(true);
    setPinError(null);
    try {
      await editPayment(ticket.id, pending.body, pin, pending.reason);
      haptic.success();
      toast.show({ tone: 'success', title: t('mgr.actions.editPaymentOk') });
      refresh();
      void qc.invalidateQueries({ queryKey: qkm.editHistory(ticket.id) });
      close();
    } catch (e) {
      const err = toApiError(e);
      haptic.error();
      if (err.status === 429) setLockedUntil(Date.now() + 60_000);
      else if (err.code === 'INVALID_PIN') setPinError(t('pin.wrong'));
      else {
        toast.show({ tone: 'error', title: t('errors.title'), message: message(e) });
        // 422 NO_CHANGES / REASON_REQUIRED: back to the form
        if (RETRYABLE.has(err.code)) setFlow('editPayment');
        else {
          refresh();
          close();
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const timer = activeTimer(ticket) ?? timerSessions(ticket).at(-1) ?? null;
  const row = (r: ActionRow & { show: boolean }): ActionRow | null => (r.show ? r : null);
  const rows = [
    row({ show: flags.promotions, icon: 'tag-outline', label: t('mgr.actions.promotions'), disabled: offline, onPress: () => setFlow('promos'), testID: 'mgr-promos' }),
    row({ show: flags.editTimer, icon: 'timer-edit-outline', label: t('mgr.actions.editTimer'), disabled: offline, onPress: () => setFlow('editTimer'), testID: 'mgr-edit-timer' }),
    row({ show: flags.voidTimer, icon: 'timer-off-outline', label: t('mgr.actions.voidTimer'), danger: true, disabled: offline, onPress: () => setFlow('voidTimer'), testID: 'mgr-void-timer' }),
    row({ show: flags.reprint, icon: 'printer-check', label: t('mgr.actions.reprint'), disabled: offline || busy, loading: busy && flow === 'reprint', onPress: () => setFlow('reprint'), testID: 'mgr-reprint' }),
    row({ show: flags.editPayment, icon: 'cash-edit', label: t('mgr.actions.editPayment'), disabled: offline, onPress: () => setFlow('editPayment'), testID: 'mgr-edit-payment' }),
    row({ show: flags.reopen, icon: 'lock-open-variant-outline', label: t('mgr.actions.reopen'), disabled: offline, onPress: () => setFlow('reopen'), testID: 'mgr-reopen' }),
    row({ show: flags.forceClose, icon: 'lock-check-outline', label: t('mgr.actions.forceClose'), danger: true, disabled: offline, onPress: () => setFlow('forceClose'), testID: 'mgr-force-close' }),
  ];

  return (
    <View testID="manager-actions" style={styles.wrap}>
      <TicketMoreActions title={t('mgr.actions.title')} rows={rows} />

      {history.data && history.data.length > 0 && (
        <View testID="edit-history" style={styles.history}>
          <AppText variant="label" bold color={colors.textSecondary}>
            {t('mgr.actions.history')}
          </AppText>
          {history.data.map((h) => (
            <View key={h.id} style={styles.histRow}>
              <AppText variant="body">{h.reason ?? h.action}</AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {h.created_at ? mexicoClock(h.created_at) : ''}
              </AppText>
            </View>
          ))}
        </View>
      )}

      {flow === 'forceClose' && (
        <ReasonSheet testID="force-close-sheet" title={t('mgr.actions.forceCloseTitle')} hint={t('mgr.actions.forceCloseHint')} required confirmLabel={t('mgr.actions.forceClose')} danger busy={busy} onClose={close} onConfirm={(reason) => void run(() => forceClose(ticket.id, reason), t('mgr.actions.forceCloseOk'), onGone)} />
      )}
      {flow === 'reopen' && (
        <ReasonSheet testID="reopen-sheet" title={t('mgr.actions.reopenTitle')} hint={t('mgr.actions.reopenHint')} required={false} confirmLabel={t('mgr.actions.reopen')} busy={busy} onClose={close} onConfirm={(reason) => void run(() => reopenTicket(ticket.id, reason || undefined), t('mgr.actions.reopenOk'))} />
      )}
      {flow === 'editPayment' && <PaymentEditSheet ticket={ticket} onClose={close} onNext={(body, reason) => { setPending({ body, reason }); setFlow('editPaymentPin'); }} />}
      {flow === 'editPaymentPin' && (
        <SheetModal visible testID="pin-sheet" onClose={busy ? undefined : close}>
          <PinPad title={t('pin.title')} message={t('mgr.actions.editPaymentPin')} error={pinError} lockedUntil={lockedUntil} loading={busy} onSubmit={(pin) => void submitPin(pin)} onCancel={close} />
        </SheetModal>
      )}
      {flow === 'promos' && (
        <PromoSheet
          offers={promoOffers(ticket)}
          busy={busy}
          onClose={close}
          onDecide={(id, decision) => void run(() => decidePromotion(ticket.id, id, decision), decision === 'ACCEPTED' ? t('mgr.actions.promoAccepted') : t('mgr.actions.promoDeclined'))}
        />
      )}
      {flow === 'editTimer' && timer && (
        <TimerSheet
          session={timer}
          busy={busy}
          serverError={timerError}
          onClose={close}
          onSubmit={(edit, reason) => void run(() => editTimer(ticket.id, timer.id, { ...edit, reason }), t('mgr.actions.timerOk'))}
        />
      )}

      <ConfirmDialog
        visible={flow === 'reprint'}
        title={t('mgr.actions.reprintTitle')}
        message={t('mgr.actions.reprintBody')}
        confirmLabel={t('mgr.actions.reprint')}
        cancelLabel={t('cancel')}
        loading={busy}
        onCancel={close}
        onConfirm={() => void run(() => reprintTicket(ticket.id, user.id), t('mgr.actions.reprintOk'))}
        testID="reprint-dialog"
      />
      <ConfirmDialog
        visible={flow === 'voidTimer'}
        title={t('mgr.actions.voidTimerTitle')}
        message={t('mgr.actions.voidTimerBody')}
        confirmLabel={t('mgr.actions.voidTimer')}
        cancelLabel={t('cancel')}
        destructive
        loading={busy}
        onCancel={close}
        onConfirm={() =>
          void run(
            () => voidTimer(ticket.id),
            (r) => ((r as { ticket_closed?: boolean }).ticket_closed ? t('mgr.actions.voidTimerClosed') : t('mgr.actions.voidTimerExpress')),
            (r) => (r as { ticket_closed?: boolean }).ticket_closed && onGone(),
          )
        }
        testID="void-timer-dialog"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s2 },
  history: { gap: spacing.s1, padding: spacing.s3, borderRadius: radii.md, backgroundColor: colors.surface },
  histRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.s2 },
});
