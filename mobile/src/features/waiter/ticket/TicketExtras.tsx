import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toApiError } from '../../../api/client';
import { printPreBill, setCustomerName, setDiscount, transferTicket } from '../../../api/endpoints/ticketOps';
import { updateQty, voidItem } from '../../../api/endpoints/tickets';
import { qk } from '../../../api/queryKeys';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { AppTextField } from '../../../components/AppTextField';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { PinPad } from '../../../components/PinPad';
import { QuantityStepper } from '../../../components/QuantityStepper';
import { useToast } from '../../../components/Toast';
import type { Resource, Ticket, TicketLineItem } from '../../../domain/types';
import { colors, spacing } from '../../../theme/tokens';
import { errorMessage } from '../../../utils/errorMessage';
import { haptic } from '../../../utils/haptics';
import { CUSTOMER_NAME_MAX } from '../openTable/OpenTableScreen';
import { useResources } from '../queries';
import { Sheet } from '../ui/Sheet';
import { TicketMoreActions, type ActionRow } from './TicketMoreActions';

/** P1 ticket actions: void / quantity change (manager PIN), customer name, transfer table, pre-bill, discount (manager). */
type Flow =
  | null
  | { kind: 'lineMenu'; line: TicketLineItem }
  | { kind: 'voidConfirm'; line: TicketLineItem }
  | { kind: 'voidPin'; line: TicketLineItem }
  | { kind: 'qty'; line: TicketLineItem; qty: number }
  | { kind: 'qtyPin'; line: TicketLineItem; qty: number }
  | { kind: 'name' }
  | { kind: 'transfer' }
  | { kind: 'discount'; pct: number };

/** HTTP 429 on verify-pin / PIN endpoints: lock the pad for a minute. */
const lockUntil = () => Date.now() + 60_000;
/** SEC-07: the void/qty endpoints have no server-side limiter yet, so 3 wrong PINs in a row cool the pad down client-side. */
export const PIN_MAX_WRONG = 3;
export const PIN_COOLDOWN_MS = 30_000;
/** Module-level so closing/reopening the sheet or leaving the screen does not reset the cooldown. */
const pinGuard = { wrong: 0, until: 0 };
export const resetPinGuard = () => {
  pinGuard.wrong = 0;
  pinGuard.until = 0;
};
const activeLock = () => (pinGuard.until > Date.now() ? pinGuard.until : null);
const pinOk = () => {
  pinGuard.wrong = 0;
};
/** Server said 429: lock for a minute. Returns the lock end. */
const pinRateLimited = () => (pinGuard.until = lockUntil());
/** Wrong PIN: returns the cooldown end when this was the 3rd in a row, else null. */
const pinWrong = (): number | null => {
  pinGuard.wrong += 1;
  if (pinGuard.wrong < PIN_MAX_WRONG) return null;
  pinGuard.wrong = 0;
  return (pinGuard.until = Date.now() + PIN_COOLDOWN_MS);
};

export const DISCOUNT_PRESETS = [0, 5, 10, 15, 20, 25, 50];

export interface TicketExtrasCtl {
  flow: Flow;
  setFlow: (f: Flow) => void;
  manager: boolean;
  ticketId: string;
  openLineActions: (line: TicketLineItem) => void;
}

export function useTicketExtras(ticketId: string, mode: 'waiter' | 'manager'): TicketExtrasCtl {
  const [flow, setFlow] = useState<Flow>(null);
  return { flow, setFlow, manager: mode === 'manager', ticketId, openLineActions: (line) => line.status !== 'VOIDED' && setFlow({ kind: 'lineMenu', line }) };
}

function SheetModal({ children, onClose, testID }: { children: ReactNode; onClose?: () => void; testID: string }) {
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <Sheet testID={testID} onClose={onClose}>
        {children}
      </Sheet>
    </Modal>
  );
}

/** `bill` / `repeat` / `cancel` rows are built by the screen (they need its mutations) and slotted into the list in spec order. */
export function TicketExtras({ ctl, ticket, offline, bill, repeat, cancel }: { ctl: TicketExtrasCtl; ticket: Ticket; offline: boolean; bill?: ActionRow | null; repeat?: ActionRow | null; cancel?: ActionRow | null }) {
  const { t } = useTranslation('mobile');
  const qc = useQueryClient();
  const toast = useToast();
  const resources = useResources();
  const { flow, setFlow, manager, ticketId } = ctl;
  const [busy, setBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(activeLock);
  const [name, setName] = useState(ticket.customer_name ?? '');

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.ticket(ticketId) });
    void qc.invalidateQueries({ queryKey: qk.resources });
  };
  const close = () => {
    setFlow(null);
    setPinError(null);
  };

  /** Runs a PIN-guarded call: wrong PIN keeps the pad open with an error; 429 locks it; other errors toast. */
  const guarded = async (action: () => Promise<void>, okTitle: string) => {
    setBusy(true);
    setPinError(null);
    try {
      await action();
      pinOk();
      haptic.success();
      toast.show({ tone: 'success', title: okTitle });
      refresh();
      close();
    } catch (e) {
      const err = toApiError(e);
      if (err.status === 429) setLockedUntil(pinRateLimited());
      else if (err.code === 'INVALID_PIN' || err.code === 'MANAGER_REQUIRED') {
        const until = pinWrong();
        if (until) setLockedUntil(until);
        else setPinError(t('pin.wrong'));
      } else {
        toast.show({ tone: 'error', title: t('errors.title'), message: errorMessage(e) });
        refresh();
        close();
      }
    } finally {
      setBusy(false);
    }
  };

  const simple = async (action: () => Promise<unknown>, okTitle: string, overrides?: Record<string, string>) => {
    setBusy(true);
    try {
      await action();
      haptic.success();
      toast.show({ tone: 'success', title: okTitle });
      refresh();
      close();
    } catch (e) {
      haptic.error();
      toast.show({ tone: 'error', title: t('errors.title'), message: errorMessage(e, overrides) });
      refresh();
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  const free: Resource[] = (resources.data ?? []).filter((r) => r.status === 'AVAILABLE' && r.is_active && !r.active_ticket_id && r.id !== ticket.resource_id);

  const pinPad = (title: string, message: string, onSubmit: (pin: string) => void) => (
    <SheetModal testID="pin-sheet" onClose={busy ? undefined : close}>
      <PinPad title={title} message={message} error={pinError} lockedUntil={lockedUntil} loading={busy} onSubmit={onSubmit} onCancel={close} />
    </SheetModal>
  );

  return (
    <View testID="ticket-extras" style={styles.wrap}>
      <TicketMoreActions
        title={t('waiter.ticket.actions')}
        rows={[
          bill,
          { icon: 'printer-outline', label: t('waiter.ticket.print'), disabled: offline || busy, onPress: () => void simple(() => printPreBill(ticketId), t('waiter.ticket.printOk'), { HTTP_503: t('waiter.ticket.printDown'), HTTP_500: t('waiter.ticket.printDown') }), testID: 'ticket-print' },
          { icon: 'account-edit-outline', label: t('waiter.ticket.editName'), disabled: offline, onPress: () => { setName(ticket.customer_name ?? ''); setFlow({ kind: 'name' }); }, testID: 'ticket-edit-name' },
          !!ticket.resource_id && { icon: 'swap-horizontal', label: t('waiter.ticket.transfer'), disabled: offline, onPress: () => setFlow({ kind: 'transfer' }), testID: 'ticket-transfer' },
          manager && { icon: 'percent-outline', label: t('waiter.ticket.discountAction'), disabled: offline, onPress: () => setFlow({ kind: 'discount', pct: ticket.manual_discount_pct ?? 0 }), testID: 'ticket-discount-btn' },
          repeat,
          cancel,
        ]}
      />

      {flow?.kind === 'lineMenu' && (
        <SheetModal testID="line-actions" onClose={close}>
          <AppText variant="headline">{`${flow.line.quantity}× ${flow.line.menu_item_name}`}</AppText>
          <AppButton label={t('waiter.ticket.qtyChange')} variant="secondary" size="lg" icon="counter" disabled={offline} onPress={() => setFlow({ kind: 'qty', line: flow.line, qty: flow.line.quantity })} testID="line-action-qty" />
          <AppButton label={t('waiter.ticket.voidTitle')} variant="dangerOutline" size="lg" icon="delete-outline" disabled={offline} onPress={() => setFlow({ kind: 'voidConfirm', line: flow.line })} testID="line-action-void" />
          <AppButton label={t('cancel')} variant="ghost" onPress={close} />
        </SheetModal>
      )}

      <ConfirmDialog
        visible={flow?.kind === 'voidConfirm'}
        title={t('waiter.ticket.voidConfirmTitle', { name: flow?.kind === 'voidConfirm' ? flow.line.menu_item_name : '' })}
        message={t('waiter.ticket.voidConfirmBody')}
        confirmLabel={t('waiter.ticket.voidConfirm')}
        cancelLabel={t('cancel')}
        destructive
        onCancel={close}
        onConfirm={() => flow?.kind === 'voidConfirm' && setFlow({ kind: 'voidPin', line: flow.line })}
        testID="void-dialog"
      />
      {flow?.kind === 'voidPin' && pinPad(t('pin.title'), t('waiter.ticket.voidSubtitle'), (pin) => void guarded(() => voidItem(ticketId, flow.line.id, pin, 'mobile'), t('waiter.ticket.voidOk')))}

      {flow?.kind === 'qty' && (
        <SheetModal testID="qty-sheet" onClose={close}>
          <AppText variant="headline">{t('waiter.ticket.qtyTitle', { name: flow.line.menu_item_name })}</AppText>
          <View style={styles.center}>
            <QuantityStepper value={flow.qty} onChange={(q) => setFlow({ ...flow, qty: q })} testID="qty-stepper" />
          </View>
          {flow.qty < flow.line.quantity && (
            <AppText variant="label" color={colors.textSecondary} style={styles.centerText}>
              {t('waiter.ticket.qtyDecreasePin')}
            </AppText>
          )}
          <AppButton
            label={t('waiter.ticket.apply')}
            size="lg"
            fullWidth
            loading={busy}
            disabled={flow.qty === flow.line.quantity}
            onPress={() => (flow.qty < flow.line.quantity ? setFlow({ kind: 'qtyPin', line: flow.line, qty: flow.qty }) : void simple(() => updateQty(ticketId, flow.line.id, flow.qty), t('waiter.ticket.qtyOk')))}
            testID="qty-apply"
          />
        </SheetModal>
      )}
      {flow?.kind === 'qtyPin' && pinPad(t('pin.title'), t('waiter.ticket.qtyDecreasePin'), (pin) => void guarded(() => updateQty(ticketId, flow.line.id, flow.qty, pin).then(() => undefined), t('waiter.ticket.qtyOk')))}

      {flow?.kind === 'name' && (
        <SheetModal testID="name-sheet" onClose={busy ? undefined : close}>
          <AppText variant="headline">{t('waiter.ticket.nameTitle')}</AppText>
          <AppTextField label={t('waiter.open.customer')} value={name} onChangeText={setName} maxLength={CUSTOMER_NAME_MAX} autoCapitalize="words" testID="name-input" />
          <AppButton label={t('waiter.ticket.nameSave')} size="lg" fullWidth loading={busy} onPress={() => void simple(() => setCustomerName(ticketId, name.trim()), t('waiter.ticket.nameSave'))} testID="name-save" />
        </SheetModal>
      )}

      {flow?.kind === 'transfer' && (
        <SheetModal testID="transfer-sheet" onClose={busy ? undefined : close}>
          <AppText variant="headline">{t('waiter.ticket.transferTitle')}</AppText>
          {free.length === 0 ? (
            <AppText variant="body" color={colors.textSecondary}>
              {t('waiter.ticket.transferNone')}
            </AppText>
          ) : (
            <View style={styles.actions}>
              {free.map((r) => (
                <AppButton
                  key={r.id}
                  label={r.code}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void simple(() => transferTicket(ticketId, r.id), t('waiter.ticket.transferOk', { code: r.code }), { RESOURCE_OCCUPIED: t('waiter.ticket.transferOccupied') })}
                  testID={`transfer-${r.code}`}
                />
              ))}
            </View>
          )}
        </SheetModal>
      )}

      {flow?.kind === 'discount' && (
        <SheetModal testID="discount-sheet" onClose={close}>
          <AppText variant="headline">{t('waiter.ticket.discountTitle')}</AppText>
          <View style={styles.actions}>
            {DISCOUNT_PRESETS.map((p) => (
              <AppButton key={p} label={`${p}%`} variant={flow.pct === p ? 'primary' : 'secondary'} onPress={() => setFlow({ kind: 'discount', pct: p })} testID={`discount-${p}`} />
            ))}
          </View>
          <AppButton label={t('waiter.ticket.apply')} size="lg" fullWidth loading={busy} onPress={() => void simple(() => setDiscount(ticketId, flow.pct, 'mobile'), t('waiter.ticket.discountOk'))} testID="discount-apply" />
        </SheetModal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s2, paddingTop: spacing.s2 },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  center: { alignItems: 'center' },
  centerText: { textAlign: 'center' },
});
