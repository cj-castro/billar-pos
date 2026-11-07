import { useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { PromoOffer, TimerSession } from '../../api/endpoints/managerOps';
import { AppButton } from '../../components/AppButton';
import { AppText } from '../../components/AppText';
import { AppTextField } from '../../components/AppTextField';
import { Chip } from '../../components/Chip';
import type { Ticket } from '../../domain/types';
import { colors, spacing } from '../../theme/tokens';
import { formatMXN } from '../../utils/money';
import { SheetModal } from '../common/SheetModal';
import {
  buildPaymentEdit,
  buildTimerEdit,
  formFromTicket,
  timerFormDefaults,
  type PayMethod,
  type PaymentEditError,
  type PaymentForm,
  type TipSource,
} from './managerActionsModel';

/** Scrollable sheet content: long forms must not push the confirm button off screen. */
function Body({ children }: { children: ReactNode }) {
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  );
}

interface CommonProps {
  busy?: boolean;
  onClose: () => void;
}

/** Reason (required or optional) + confirm. Used by force-close and reopen. */
export function ReasonSheet({ testID, title, hint, required, confirmLabel, danger, busy, onConfirm, onClose }: CommonProps & { testID: string; title: string; hint?: string; required: boolean; confirmLabel: string; danger?: boolean; onConfirm: (reason: string) => void }) {
  const { t } = useTranslation('mobile');
  const [reason, setReason] = useState('');
  return (
    <SheetModal visible testID={testID} onClose={busy ? undefined : onClose}>
      <Body>
        <AppText variant="headline">{title}</AppText>
        {!!hint && (
          <AppText variant="body" color={colors.textSecondary}>
            {hint}
          </AppText>
        )}
        <AppTextField label={required ? t('mgr.actions.reason') : t('mgr.actions.reasonOptional')} value={reason} onChangeText={setReason} maxLength={200} testID={`${testID}-reason`} />
        <AppButton
          label={confirmLabel}
          variant={danger ? 'danger' : 'primary'}
          size="lg"
          fullWidth
          loading={busy}
          disabled={required && reason.trim() === ''}
          onPress={() => onConfirm(reason.trim())}
          testID={`${testID}-confirm`}
        />
      </Body>
    </SheetModal>
  );
}

const METHODS: PayMethod[] = ['CASH', 'CARD', 'EXTERNAL'];
const TIP_SOURCES: TipSource[] = ['', 'CASH', 'CARD', 'SPLIT'];

/** Edit the payment of a CLOSED ticket, prefilled. Reason required; the PIN is asked by the parent next. */
export function PaymentEditSheet({ ticket, onNext, onClose }: Pick<CommonProps, 'onClose'> & { ticket: Ticket; onNext: (body: Record<string, unknown>, reason: string) => void }) {
  const { t } = useTranslation('mobile');
  const [f, setF] = useState<PaymentForm>(() => formFromTicket(ticket));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<PaymentEditError | null>(null);
  const set = <K extends keyof PaymentForm>(k: K, v: PaymentForm[K]) => {
    setF((p) => ({ ...p, [k]: v }));
    setError(null);
  };
  const next = () => {
    const r = buildPaymentEdit(ticket, f);
    if (!r.ok) setError(r.error);
    else onNext(r.body, reason.trim());
  };
  const amount = (key: 'tendered' | 'tip' | 'tendered2' | 'tipCash' | 'tipCard', label: string) => (
    <AppTextField label={label} value={f[key]} onChangeText={(v) => set(key, v)} keyboardType="decimal-pad" testID={`pay-edit-${key}`} />
  );
  return (
    <SheetModal visible testID="pay-edit-sheet" onClose={onClose}>
      <Body>
        <AppText variant="headline">{t('mgr.actions.editPaymentTitle')}</AppText>
        <AppText variant="label" color={colors.textSecondary}>
          {t('mgr.actions.paymentType')}
        </AppText>
        <View style={styles.chips}>
          {METHODS.map((m) => (
            <Chip key={m} label={t(`mgr.actions.method.${m}`)} on={f.paymentType === m} onPress={() => set('paymentType', m)} testID={`pay-edit-type-${m}`} />
          ))}
        </View>
        {amount('tendered', t('mgr.actions.tendered'))}
        <AppText variant="label" color={colors.textSecondary}>
          {t('mgr.actions.paymentType2')}
        </AppText>
        <View style={styles.chips}>
          {(['', 'CASH', 'CARD'] as const).map((m) => (
            <Chip key={m || 'none'} label={m ? t(`mgr.actions.method.${m}`) : t('mgr.actions.none')} on={f.paymentType2 === m} onPress={() => set('paymentType2', m)} testID={`pay-edit-type2-${m || 'none'}`} />
          ))}
        </View>
        {!!f.paymentType2 && amount('tendered2', t('mgr.actions.tendered2'))}
        {amount('tip', t('mgr.actions.tip'))}
        <AppText variant="label" color={colors.textSecondary}>
          {t('mgr.actions.tipSource')}
        </AppText>
        <View style={styles.chips}>
          {TIP_SOURCES.map((s) => (
            <Chip key={s || 'none'} label={s ? t(`mgr.actions.tipSrc.${s}`) : t('mgr.actions.none')} on={f.tipSource === s} onPress={() => set('tipSource', s)} testID={`pay-edit-tipsrc-${s || 'none'}`} />
          ))}
        </View>
        {f.tipSource === 'SPLIT' && (
          <>
            {amount('tipCash', t('mgr.actions.tipCash'))}
            {amount('tipCard', t('mgr.actions.tipCard'))}
          </>
        )}
        <AppTextField label={t('mgr.actions.reason')} value={reason} onChangeText={setReason} maxLength={200} testID="pay-edit-reason" />
        {!!error && (
          <AppText variant="body" color={colors.dangerText} accessibilityRole="alert" testID="pay-edit-error">
            {t(`mgr.actions.payErr.${error}`)}
          </AppText>
        )}
        <AppButton label={t('mgr.actions.continuePin')} size="lg" fullWidth disabled={reason.trim() === ''} onPress={next} testID="pay-edit-next" />
      </Body>
    </SheetModal>
  );
}

/** Pending quantity promos: accept or decline each. */
export function PromoSheet({ offers, busy, onDecide, onClose }: CommonProps & { offers: PromoOffer[]; onDecide: (id: string, decision: 'ACCEPTED' | 'DECLINED') => void }) {
  const { t } = useTranslation('mobile');
  return (
    <SheetModal visible testID="promo-sheet" onClose={busy ? undefined : onClose}>
      <Body>
        <AppText variant="headline">{t('mgr.actions.promotions')}</AppText>
        {offers.length === 0 && (
          <AppText variant="body" color={colors.textSecondary} testID="promo-none">
            {t('mgr.actions.promoNone')}
          </AppText>
        )}
        {offers.map((o) => (
          <View key={o.promotion_id} style={styles.promo} testID={`promo-${o.promotion_id}`}>
            <AppText variant="title">{o.name}</AppText>
            <AppText variant="label" color={colors.textSecondary}>
              {o.free_pool_minutes ? t('mgr.actions.promoFree', { min: o.free_pool_minutes }) : t('mgr.actions.promoSaves', { amount: formatMXN(o.discount_cents) })}
            </AppText>
            <View style={styles.row}>
              <AppButton label={t('mgr.actions.decline')} variant="secondary" disabled={busy} onPress={() => onDecide(o.promotion_id, 'DECLINED')} style={styles.flex} testID={`promo-decline-${o.promotion_id}`} />
              <AppButton label={t('mgr.actions.accept')} loading={busy} onPress={() => onDecide(o.promotion_id, 'ACCEPTED')} style={styles.flex} testID={`promo-accept-${o.promotion_id}`} />
            </View>
          </View>
        ))}
      </Body>
    </SheetModal>
  );
}

/** Correct a pool timer: venue-local HH:MM start / end (no native picker installed). */
export function TimerSheet({ session, busy, serverError, onSubmit, onClose }: CommonProps & { session: TimerSession; serverError?: string | null; onSubmit: (edit: { start_time: string; end_time?: string }, reason: string) => void }) {
  const { t } = useTranslation('mobile');
  const d = timerFormDefaults(session);
  const [start, setStart] = useState(d.start);
  const [end, setEnd] = useState(d.end);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<'start' | 'end' | null>(null);
  const submit = () => {
    const r = buildTimerEdit(session, start, end);
    if (!r.ok) setError(r.error);
    else onSubmit({ start_time: r.start_time, end_time: r.end_time }, reason.trim());
  };
  return (
    <SheetModal visible testID="timer-sheet" onClose={busy ? undefined : onClose}>
      <Body>
        <AppText variant="headline">{t('mgr.actions.editTimerTitle')}</AppText>
        <AppTextField label={t('mgr.actions.timerStart')} value={start} onChangeText={(v) => { setStart(v); setError(null); }} placeholder="HH:MM" keyboardType="numbers-and-punctuation" maxLength={5} error={error === 'start' ? t('mgr.actions.timerInvalid') : null} testID="timer-start" />
        <AppTextField label={t('mgr.actions.timerEnd')} value={end} onChangeText={(v) => { setEnd(v); setError(null); }} placeholder="HH:MM" keyboardType="numbers-and-punctuation" maxLength={5} error={error === 'end' ? t('mgr.actions.timerInvalid') : null} testID="timer-end" />
        <AppText variant="label" color={colors.textMuted}>
          {session.end_time ? t('mgr.actions.timerHintEnded') : t('mgr.actions.timerHintRunning')}
        </AppText>
        <AppTextField label={t('mgr.actions.reason')} value={reason} onChangeText={setReason} maxLength={200} testID="timer-reason" />
        {!!serverError && (
          <AppText variant="body" color={colors.dangerText} accessibilityRole="alert">
            {serverError}
          </AppText>
        )}
        <AppButton label={t('mgr.actions.timerSave')} size="lg" fullWidth loading={busy} disabled={reason.trim() === ''} onPress={submit} testID="timer-save" />
      </Body>
    </SheetModal>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0 },
  body: { gap: spacing.s3, paddingBottom: spacing.s2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  promo: { gap: spacing.s2, padding: spacing.s3, borderRadius: 12, backgroundColor: colors.surfaceRaised },
  row: { flexDirection: 'row', gap: spacing.s2 },
  flex: { flex: 1 },
});
