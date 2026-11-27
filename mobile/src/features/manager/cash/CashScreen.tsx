import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { toApiError } from '../../../api/client';
import { addExpense, closeCash, deleteExpense, getCashStatus, getCashSummary, listCashSessions, listSessionTickets, openCash, type CashExpense, type CashSummaryResponse } from '../../../api/endpoints/cash';
import { qk, qkm } from '../../../api/queryKeys';

import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { AppTextField } from '../../../components/AppTextField';
import { Chip } from '../../../components/Chip';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { useConnectionLevel } from '../../../components/connection';
import { EmptyState } from '../../../components/EmptyState';
import { ErrorState } from '../../../components/ErrorState';
import { IconButton } from '../../../components/IconButton';
import { LoadingSkeleton } from '../../../components/LoadingSkeleton';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { SectionHeader } from '../../../components/SectionHeader';
import { useToast } from '../../../components/Toast';
import { colors, radii, spacing } from '../../../theme/tokens';
import { errorMessage } from '../../../utils/errorMessage';
import { haptic } from '../../../utils/haptics';
import { formatMXN } from '../../../utils/money';
import { formatClock } from '../../../utils/time';
import { SheetModal } from '../../common/SheetModal';
import { mk } from '../keys';
import { parsePesos } from '../managerActionsModel';
import { mexicoClock } from '../mexDate';
import { useRefreshOnEvents } from '../useRefreshOnEvents';
import { canClose, canCloseCounted, cashDifference, clampTo, diffTone, expenseBody, openTicketsCount, recentSessions, splitEnvelope, toApi, totalCents, validateExpense, type CountLines } from './cashModel';
import { CountGrid } from './CountGrid';

type Sheet = null | 'open' | 'expense' | 'close';

function Line({ label, value, strong, tone, testID }: { label: string; value: string; strong?: boolean; tone?: 'ok' | 'over' | 'short'; testID?: string }) {
  const color = tone === 'short' ? colors.dangerText : tone === 'ok' || tone === 'over' ? colors.success : colors.textPrimary;
  return (
    <View style={styles.line} testID={testID} accessible accessibilityLabel={`${label}: ${value}`}>
      <AppText variant={strong ? 'title' : 'body'} bold={strong} color={strong ? colors.textPrimary : colors.textSecondary} style={styles.flex}>
        {label}
      </AppText>
      <AppText variant={strong ? 'title' : 'body'} bold color={color}>
        {value}
      </AppText>
    </View>
  );
}

function Collapsible({ title, open, onToggle, testID, children }: { title: string; open: boolean; onToggle: () => void; testID: string; children: ReactNode }) {
  return (
    <View style={styles.card}>
      <Pressable testID={testID} accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={title} onPress={onToggle} style={styles.collapseHead}>
        <AppText variant="title" style={styles.flex}>
          {title}
        </AppText>
        <MaterialCommunityIcons name={open ? 'chevron-up' : 'chevron-down'} size={24} color={colors.textSecondary} />
      </Pressable>
      {open && children}
    </View>
  );
}

/** Amount readout + decimal pesos input (centavos allowed). Invalid / empty text -> null. */
function AmountPad({ cents, onChange, testID }: { cents: number | null; onChange: (c: number | null) => void; testID: string }) {
  const { t } = useTranslation('mobile');
  const [text, setText] = useState('');
  return (
    <>
      <AppText variant="display" style={styles.center} testID={`${testID}-amount`} accessibilityLiveRegion="polite">
        {formatMXN(cents ?? 0)}
      </AppText>
      <AppTextField
        label={t('mgr.cash.amount')}
        value={text}
        onChangeText={(v) => {
          setText(v);
          const c = parsePesos(v);
          onChange(c == null || Number.isNaN(c) ? null : c);
        }}
        keyboardType="decimal-pad"
        testID={testID}
      />
    </>
  );
}

/** SCR-M-05 Caja: open / close the register, expenses, session tickets, history. */
export function CashScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const offline = useConnectionLevel() === 'offline';
  const [sheet, setSheet] = useState<Sheet>(null);
  const [fund, setFund] = useState<number | null>(null);
  const [counted, setCounted] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [openTickets, setOpenTickets] = useState<number | null>(null);
  const [closedResult, setClosedResult] = useState<CashSummaryResponse | null>(null);
  const [expForm, setExpForm] = useState({ description: '', payee: '', amount: '', method: 'CASH' as 'CASH' | 'CARD' });
  const [expError, setExpError] = useState<string | null>(null);
  const [delExpense, setDelExpense] = useState<CashExpense | null>(null);
  const [showTickets, setShowTickets] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [openCount, setOpenCount] = useState<CountLines>({});
  const [closeCount, setCloseCount] = useState<CountLines>({});
  const [leftCount, setLeftCount] = useState<CountLines>({});
  const [zeroConfirm, setZeroConfirm] = useState<null | 'open' | 'close'>(null);
  const [closeStep, setCloseStep] = useState<'reminder' | 'count' | 'left'>('reminder');

  const summaryQ = useQuery({ queryKey: qkm.cashSummary, queryFn: getCashSummary, refetchInterval: 30_000 });
  // Count by denomination. If the status call fails the screen falls back to today's amount pad.
  const statusQ = useQuery({ queryKey: mk.cashStatus, queryFn: getCashStatus, refetchInterval: 30_000 });
  const denoms = statusQ.data?.denominations ?? [];
  const countMode = !!statusQ.data?.count_by_denomination && denoms.length > 0;
  const fundTarget = statusQ.data?.fund_target_cents ?? 0;
  const ticketsQ = useQuery({ queryKey: qkm.cashTickets, queryFn: listSessionTickets, enabled: showTickets && !!summaryQ.data });
  const sessionsQ = useQuery({ queryKey: qkm.cashSessions, queryFn: listCashSessions, enabled: showHistory });
  useRefreshOnEvents([qkm.cashSummary, mk.cashStatus, qkm.cashTickets]);

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: qk.cash });
    void qc.invalidateQueries({ queryKey: qk.tickets });
  };
  const fail = (e: unknown, overrides?: Record<string, string>) => {
    haptic.error();
    toast.show({ tone: 'error', title: t('errors.title'), message: errorMessage(e, overrides) });
  };

  const open = useMutation({
    retry: 0,
    mutationFn: () => openCash(countMode ? { count: toApi(openCount) } : (fund ?? 0)),
    onSuccess: () => {
      haptic.success();
      toast.show({ tone: 'success', title: t('mgr.cash.openedOk') });
      setSheet(null);
      setClosedResult(null);
      refreshAll();
    },
    onError: (e) => {
      const err = toApiError(e);
      if (err.status === 422 && err.message) {
        // Count errors (COUNT_REQUIRED, BAD_COUNT, ...): the server message is already in Spanish.
        haptic.error();
        toast.show({ tone: 'error', title: t('errors.title'), message: err.message });
        return;
      }
      fail(e, { SESSION_ALREADY_OPEN: t('mgr.cash.alreadyOpen') });
      refreshAll();
    },
  });

  const close = useMutation({
    retry: 0,
    mutationFn: () => (countMode ? closeCash({ count: toApi(closeCount), drawerLeft: toApi(leftCount), notes: notes.trim() }) : closeCash(counted ?? 0, notes.trim())),
    onSuccess: (r) => {
      haptic.success();
      setClosedResult(r);
      setSheet(null);
      setCounted(null);
      setCloseCount({});
      setLeftCount({});
      setNotes('');
      refreshAll();
    },
    onError: (e) => {
      const err = toApiError(e);
      if (err.code === 'OPEN_TICKETS') {
        haptic.error();
        setOpenTickets(openTicketsCount(err.message, null) ?? -1);
      } else if (err.status === 422 && err.message) {
        haptic.error();
        toast.show({ tone: 'error', title: t('errors.title'), message: err.message });
      } else {
        fail(e, { NO_OPEN_SESSION: t('mgr.cash.noSession') });
        refreshAll();
      }
    },
  });

  const expense = useMutation({
    retry: 0,
    mutationFn: () => addExpense(expenseBody({ description: expForm.description, payee: expForm.payee, amountCents: parsePesos(expForm.amount) || 0, method: expForm.method })),
    onSuccess: () => {
      haptic.success();
      toast.show({ tone: 'success', title: t('mgr.cash.expenseOk') });
      setSheet(null);
      setExpForm({ description: '', payee: '', amount: '', method: 'CASH' });
      refreshAll();
    },
    onError: (e) => fail(e),
  });

  const remove = useMutation({
    retry: 0,
    mutationFn: (id: string) => deleteExpense(id),
    onSuccess: () => {
      haptic.success();
      setDelExpense(null);
      refreshAll();
    },
    onError: (e) => {
      setDelExpense(null);
      fail(e);
      refreshAll();
    },
  });

  const submitExpense = () => {
    const amountCents = parsePesos(expForm.amount);
    const err = validateExpense({ description: expForm.description, payee: expForm.payee, amountCents: amountCents || 0, method: expForm.method });
    if (err) setExpError(t(`mgr.cash.expenseErr.${err}`));
    else {
      setExpError(null);
      expense.mutate();
    }
  };

  const sum = summaryQ.data?.summary;
  const session = summaryQ.data?.session;

  let body: ReactNode;
  if (summaryQ.isPending) body = <LoadingSkeleton variant="stats" />;
  else if (summaryQ.isError && summaryQ.data === undefined) body = <ErrorState error={summaryQ.error} onRetry={() => summaryQ.refetch()} />;
  else if (!sum || !session) {
    // A: register closed
    body = (
      <ScrollView testID="cash-closed" contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={summaryQ.isRefetching} onRefresh={() => void summaryQ.refetch()} tintColor={colors.primary} />}>
        {closedResult?.envelope && (
          <View style={styles.card} testID="cash-closed-envelope">
            <AppText variant="title">{t('mgr.cash.count.envelopeNumber', { number: closedResult.envelope.number })}</AppText>
            <Line label={t('mgr.cash.count.envelopeDeclared')} value={formatMXN(closedResult.envelope.declared_cents)} />
            <AppText variant="body" color={colors.textSecondary}>
              {t('mgr.cash.count.printHint')}
            </AppText>
          </View>
        )}
        {/* The close result (expected / counted / difference) shows after every
            close, with or without an envelope: the count was blind until the
            close was submitted; now the manager reconciles (spec 5.1 step 5). */}
        {closedResult && (
          <View style={styles.card} testID="cash-closed-summary">
            <AppText variant="title">{t('mgr.cash.closedSummary')}</AppText>
            <Line label={t('mgr.cash.expected')} value={formatMXN(closedResult.summary.expected_cash_cents)} />
            <Line label={t('mgr.cash.counted')} value={formatMXN(closedResult.summary.closing_cash_counted_cents)} />
            <Line
              testID="cash-closed-diff"
              label={t('mgr.cash.difference')}
              value={formatMXN(closedResult.summary.cash_over_short_cents)}
              strong
              tone={diffTone(closedResult.summary.cash_over_short_cents ?? 0)}
            />
            <Line label={t('mgr.cash.salesTotal')} value={formatMXN(closedResult.summary.total_sales_cents)} />
          </View>
        )}
        <EmptyState icon="lock-outline" tone="warning" title={t('manager.cash.closed')} message={t('mgr.cash.closedBody')} testID="cash-closed-empty" />
        <AppButton label={t('mgr.cash.openAction')} size="lg" fullWidth icon="cash-register" disabled={offline || statusQ.isPending} onPress={() => { setFund(null); setOpenCount({}); setSheet('open'); }} testID="cash-open-btn" />
        {historyBlock()}
      </ScrollView>
    );
  } else {
    // B: register open
    const dist = sum.tip_distribution;
    body = (
      <ScrollView testID="cash-open" contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={summaryQ.isRefetching} onRefresh={() => void summaryQ.refetch()} tintColor={colors.primary} />}>
        <View style={styles.card} testID="cash-summary">
          <AppText variant="label" color={colors.textSecondary}>
            {t('manager.cash.since', { time: formatClock(session.opened_at ? new Date(session.opened_at) : null) })}
          </AppText>
          <Line testID="line-fund" label={t('mgr.cash.fund')} value={formatMXN(sum.opening_fund_cents)} />
          <Line testID="line-cash-sales" label={t('mgr.cash.cashSales')} value={formatMXN(sum.cash_sales_cents)} />
          <Line testID="line-card-sales" label={t('mgr.cash.cardSales')} value={formatMXN(sum.card_sales_cents)} />
          <Line testID="line-tips" label={t('mgr.cash.tips')} value={formatMXN(sum.total_tips_cents)} />
          <Line testID="line-expenses" label={t('mgr.cash.expenses')} value={formatMXN(sum.total_expenses_cents)} />
          {!countMode && <View style={styles.sep} />}
          {!countMode && <Line testID="line-expected" label={t('mgr.cash.expected')} value={formatMXN(sum.expected_cash_cents)} strong />}
          {!!dist && (
            <AppText variant="caption" color={colors.textMuted} testID="tip-distribution">
              {t('mgr.cash.tipDist', { floor: dist.floor_pct, bar: dist.bar_pct, kitchen: dist.kitchen_pct })}
            </AppText>
          )}
        </View>

        <SectionHeader title={t('mgr.cash.expensesTitle')} right={<AppButton label={t('mgr.cash.addExpense')} variant="secondary" icon="plus" disabled={offline} onPress={() => { setExpError(null); setSheet('expense'); }} testID="cash-add-expense" />} />
        {sum.expenses.length === 0 ? (
          <AppText variant="body" color={colors.textSecondary} testID="expenses-none">
            {t('mgr.cash.noExpenses')}
          </AppText>
        ) : (
          <View style={styles.card}>
            {sum.expenses.map((x) => (
              <View key={x.id} style={styles.expense} testID={`expense-${x.id}`}>
                <View style={styles.flex}>
                  <AppText variant="body">{x.description}</AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    {[x.payee, t(`mgr.actions.method.${x.payment_method}`), mexicoClock(x.created_at)].filter(Boolean).join(' · ')}
                  </AppText>
                </View>
                <AppText variant="body" bold>
                  {formatMXN(x.amount_cents)}
                </AppText>
                <IconButton icon="delete-outline" accessibilityLabel={t('mgr.cash.deleteExpense')} color={colors.dangerText} disabled={offline} onPress={() => setDelExpense(x)} testID={`expense-delete-${x.id}`} />
              </View>
            ))}
          </View>
        )}

        <Collapsible title={t('mgr.cash.sessionTickets', { count: sum.ticket_count })} open={showTickets} onToggle={() => setShowTickets((v) => !v)} testID="cash-tickets-toggle">
          {ticketsQ.isPending ? (
            <LoadingSkeleton variant="list" count={3} />
          ) : (ticketsQ.data ?? []).length === 0 ? (
            <AppText variant="body" color={colors.textSecondary}>
              {t('mgr.cash.noTickets')}
            </AppText>
          ) : (
            (ticketsQ.data ?? []).map((x) => (
              <Pressable key={x.id} testID={`cash-ticket-${x.id}`} accessibilityRole="button" onPress={() => router.push(`/tickets/${x.id}`)} style={styles.expense}>
                <AppText variant="body" style={styles.flex}>
                  {[x.resource_code ?? t('mgr.tickets.express'), x.customer_name].filter(Boolean).join(' · ')}
                </AppText>
                <AppText variant="body" bold>
                  {formatMXN(x.total_cents)}
                </AppText>
              </Pressable>
            ))
          )}
        </Collapsible>

        <AppButton label={t('mgr.cash.closeAction')} variant="danger" size="lg" fullWidth icon="lock-outline" disabled={offline || statusQ.isPending} onPress={() => { setCounted(null); setCloseCount({}); setLeftCount({}); setCloseStep('reminder'); setNotes(''); setOpenTickets(null); setSheet('close'); }} testID="cash-close-btn" />
        {historyBlock()}
      </ScrollView>
    );
  }

  function historyBlock() {
    return (
      <Collapsible title={t('mgr.cash.history')} open={showHistory} onToggle={() => setShowHistory((v) => !v)} testID="cash-history-toggle">
        {sessionsQ.isPending ? (
          <LoadingSkeleton variant="list" count={3} />
        ) : sessionsQ.isError ? (
          <ErrorState error={sessionsQ.error} onRetry={() => sessionsQ.refetch()} />
        ) : (
          recentSessions(sessionsQ.data ?? []).map((s) => (
            <View key={s.id} style={styles.expense} testID={`session-${s.id}`}>
              <View style={styles.flex}>
                <AppText variant="body">{s.date ?? ''}</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  {[t(`mgr.cash.status.${s.status}`), `${t('mgr.cash.fund')} ${formatMXN(s.opening_fund_cents)}`].join(' · ')}
                </AppText>
              </View>
              <AppText variant="body" bold>
                {s.closing_cash_counted_cents != null ? formatMXN(s.closing_cash_counted_cents) : '—'}
              </AppText>
            </View>
          ))
        )}
      </Collapsible>
    );
  }

  const expected = sum?.expected_cash_cents ?? 0;
  const diff = counted == null ? null : cashDifference(counted, expected);
  // Count mode: what stays in the drawer vs the fund target (blind: no expected cash anywhere).
  const leftCents = totalCents(leftCount, denoms);
  const leftGap = leftCents - fundTarget; // <0 faltan, >0 sobran
  const leftGapText =
    leftGap < 0
      ? t('mgr.cash.count.missing', { amount: formatMXN(-leftGap), target: formatMXN(fundTarget) })
      : leftGap > 0
        ? t('mgr.cash.count.extra', { amount: formatMXN(leftGap), target: formatMXN(fundTarget) })
        : t('mgr.cash.count.onTarget', { target: formatMXN(fundTarget) });
  const leftCheck = canCloseCounted(closeCount, leftCount, fundTarget, notes, denoms);
  const envelopeCents = totalCents(splitEnvelope(closeCount, leftCount), denoms);

  return (
    <ScreenScaffold testID="screen-cash" padded={false} edges={['top']} header={<ScreenHeader title={t('mgr.tabs.cash')} right={<ConnectionPill />} />} banner={<OfflineBanner />}>
      {body}

      {sheet === 'open' && (
        <SheetModal visible testID="open-cash-sheet" onClose={open.isPending ? undefined : () => setSheet(null)}>
          <AppText variant="headline">{t('mgr.cash.openTitle')}</AppText>
          {countMode ? (
            <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
              <AppText variant="body" color={colors.textSecondary}>
                {t('mgr.cash.count.openHelp')}
              </AppText>
              <CountGrid denoms={denoms} lines={openCount} onChange={setOpenCount} testIDPrefix="open-count" totalLabel={t('mgr.cash.count.total')} />
            </ScrollView>
          ) : (
            <>
              <AppText variant="body" color={colors.textSecondary}>
                {t('mgr.cash.fundLabel')}
              </AppText>
              <AmountPad cents={fund} onChange={setFund} testID="fund-pad" />
            </>
          )}
          <AppButton label={t('mgr.cash.openAction')} size="lg" fullWidth loading={open.isPending} disabled={(!countMode && fund == null) || offline} onPress={() => (countMode && totalCents(openCount, denoms) === 0 ? setZeroConfirm('open') : open.mutate())} testID="open-cash-confirm" />
        </SheetModal>
      )}

      {sheet === 'expense' && (
        <SheetModal visible testID="expense-sheet" onClose={expense.isPending ? undefined : () => setSheet(null)}>
          <AppText variant="headline">{t('mgr.cash.expenseTitle')}</AppText>
          <AppTextField label={t('mgr.cash.concept')} value={expForm.description} onChangeText={(v) => setExpForm((f) => ({ ...f, description: v }))} maxLength={120} testID="expense-description" />
          <AppTextField label={t('mgr.cash.payee')} value={expForm.payee} onChangeText={(v) => setExpForm((f) => ({ ...f, payee: v }))} maxLength={80} testID="expense-payee" />
          <AppTextField label={t('mgr.cash.amount')} value={expForm.amount} onChangeText={(v) => setExpForm((f) => ({ ...f, amount: v }))} keyboardType="decimal-pad" testID="expense-amount" />
          <View style={styles.row}>
            {(['CASH', 'CARD'] as const).map((m) => (
              <Chip key={m} label={t(`mgr.actions.method.${m}`)} on={expForm.method === m} onPress={() => setExpForm((f) => ({ ...f, method: m }))} testID={`expense-method-${m}`} />
            ))}
          </View>
          {!!expError && (
            <AppText variant="body" color={colors.dangerText} accessibilityRole="alert" testID="expense-error">
              {expError}
            </AppText>
          )}
          <AppButton label={t('mgr.cash.saveExpense')} size="lg" fullWidth loading={expense.isPending} disabled={offline} onPress={submitExpense} testID="expense-save" />
        </SheetModal>
      )}

      {sheet === 'close' && !countMode && (
        <SheetModal visible testID="close-cash-sheet" onClose={close.isPending ? undefined : () => setSheet(null)}>
          <AppText variant="headline">{t('mgr.cash.closeTitle')}</AppText>
          <Line label={t('mgr.cash.expected')} value={formatMXN(expected)} testID="close-expected" />
          <AppText variant="body" color={colors.textSecondary}>
            {t('mgr.cash.countedLabel')}
          </AppText>
          <AmountPad cents={counted} onChange={setCounted} testID="count-pad" />
          {diff != null && (
            <View testID="close-diff" accessible accessibilityLabel={`${t('mgr.cash.difference')}: ${formatMXN(diff)}`} style={[styles.diff, { backgroundColor: diffTone(diff) === 'short' ? colors.dangerTint : colors.successTint }]}>
              <AppText variant="body" style={styles.flex}>
                {t(`mgr.cash.diffLabel.${diffTone(diff)}`)}
              </AppText>
              <AppText variant="title" bold color={diffTone(diff) === 'short' ? colors.dangerText : colors.success}>
                {formatMXN(diff)}
              </AppText>
            </View>
          )}
          <AppTextField label={t('mgr.cash.notes')} value={notes} onChangeText={setNotes} maxLength={300} testID="close-notes" />
          {openTickets != null && (
            <View style={styles.blocked} accessibilityRole="alert" testID="close-open-tickets">
              <AppText variant="body" color={colors.dangerText}>
                {openTickets > 0 ? t('mgr.cash.openTickets', { count: openTickets }) : t('mgr.cash.openTicketsUnknown')}
              </AppText>
              <AppButton label={t('mgr.cash.goTickets')} variant="secondary" onPress={() => { setSheet(null); router.push('/tickets'); }} testID="close-go-tickets" />
            </View>
          )}
          <AppButton label={t('mgr.cash.confirmClose')} variant="danger" size="lg" fullWidth loading={close.isPending} disabled={!canClose(counted) || offline} onPress={() => close.mutate()} testID="close-cash-confirm" />
        </SheetModal>
      )}

      {sheet === 'close' && countMode && (
        <SheetModal visible testID="close-cash-sheet" onClose={close.isPending ? undefined : () => setSheet(null)}>
          <AppText variant="headline">{t('mgr.cash.closeTitle')}</AppText>
          {closeStep === 'reminder' && (
            <>
              <AppText variant="title" testID="close-reminder">
                {t('mgr.cash.count.reminder')}
              </AppText>
              <AppButton label={t('mgr.cash.count.reminderOk')} size="lg" fullWidth onPress={() => setCloseStep('count')} testID="close-reminder-ok" />
            </>
          )}
          {closeStep === 'count' && (
            <>
              <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
                <CountGrid
                  denoms={denoms}
                  lines={closeCount}
                  onChange={(next) => {
                    setCloseCount(next);
                    setLeftCount((l) => clampTo(l, next));
                  }}
                  testIDPrefix="close-count"
                  totalLabel={t('mgr.cash.count.total')}
                />
              </ScrollView>
              <AppButton label={t('mgr.cash.count.next')} size="lg" fullWidth onPress={() => (totalCents(closeCount, denoms) === 0 ? setZeroConfirm('close') : setCloseStep('left'))} testID="close-count-next" />
            </>
          )}
          {closeStep === 'left' && (
            <>
              <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
                <AppText variant="title">{t('mgr.cash.count.leftTitle')}</AppText>
                <AppText variant="body" color={colors.textSecondary}>
                  {t('mgr.cash.count.leftHelp')}
                </AppText>
                <CountGrid denoms={denoms.filter((d) => (closeCount[d.key] || 0) > 0)} lines={leftCount} onChange={setLeftCount} max={closeCount} testIDPrefix="left-count" totalLabel={t('mgr.cash.count.leftTotal')} />
                {leftGap !== 0 && (
                  <View testID="left-gap" accessible accessibilityLabel={leftGapText} style={[styles.diff, { backgroundColor: leftGap < 0 ? colors.dangerTint : colors.successTint }]}>
                    <AppText variant="body" bold color={leftGap < 0 ? colors.dangerText : colors.success}>
                      {leftGapText}
                    </AppText>
                  </View>
                )}
                {leftGap === 0 && (
                  <AppText variant="body" color={colors.success} testID="left-gap">
                    {leftGapText}
                  </AppText>
                )}
                <View style={styles.line} testID="envelope-total" accessible accessibilityLabel={`${t('mgr.cash.count.envelopeTotal')}: ${formatMXN(envelopeCents)}`}>
                  <AppText variant="title" style={styles.flex}>
                    {t('mgr.cash.count.envelopeTotal')}
                  </AppText>
                  <AppText variant="title" bold>
                    {formatMXN(envelopeCents)}
                  </AppText>
                </View>
                {leftCheck.reason === 'NOTE_REQUIRED' && (
                  <AppText variant="body" color={colors.dangerText} testID="close-note-required">
                    {t('mgr.cash.count.noteRequired')}
                  </AppText>
                )}
                <AppTextField label={t('mgr.cash.notes')} value={notes} onChangeText={setNotes} maxLength={300} testID="close-notes" />
                {openTickets != null && (
                  <View style={styles.blocked} accessibilityRole="alert" testID="close-open-tickets">
                    <AppText variant="body" color={colors.dangerText}>
                      {openTickets > 0 ? t('mgr.cash.openTickets', { count: openTickets }) : t('mgr.cash.openTicketsUnknown')}
                    </AppText>
                    <AppButton label={t('mgr.cash.goTickets')} variant="secondary" onPress={() => { setSheet(null); router.push('/tickets'); }} testID="close-go-tickets" />
                  </View>
                )}
              </ScrollView>
              <AppButton label={t('mgr.cash.count.back')} variant="secondary" fullWidth onPress={() => setCloseStep('count')} testID="close-count-back" />
              <AppButton label={t('mgr.cash.confirmClose')} variant="danger" size="lg" fullWidth loading={close.isPending} disabled={!leftCheck.ok || offline} onPress={() => close.mutate()} testID="close-cash-confirm" />
            </>
          )}
        </SheetModal>
      )}

      <ConfirmDialog
        visible={zeroConfirm != null}
        title={zeroConfirm === 'open' ? t('mgr.cash.count.zeroOpenTitle') : t('mgr.cash.count.zeroCloseTitle')}
        confirmLabel={zeroConfirm === 'open' ? t('mgr.cash.count.zeroOpenConfirm') : t('mgr.cash.count.zeroCloseConfirm')}
        cancelLabel={t('cancel')}
        onCancel={() => setZeroConfirm(null)}
        onConfirm={() => {
          const which = zeroConfirm;
          setZeroConfirm(null);
          if (which === 'open') open.mutate();
          else setCloseStep('left');
        }}
        testID="zero-count-dialog"
      />

      <ConfirmDialog
        visible={!!delExpense}
        title={t('mgr.cash.deleteTitle')}
        message={delExpense ? `${delExpense.description} · ${formatMXN(delExpense.amount_cents)}` : undefined}
        confirmLabel={t('mgr.cash.deleteExpense')}
        cancelLabel={t('cancel')}
        destructive
        loading={remove.isPending}
        onCancel={() => setDelExpense(null)}
        onConfirm={() => delExpense && remove.mutate(delExpense.id)}
        testID="delete-expense-dialog"
      />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheetScroll: { maxHeight: 420 },
  center: { textAlign: 'center' },
  content: { padding: spacing.s4, gap: spacing.s3, paddingBottom: spacing.s8 },
  card: { gap: spacing.s2, padding: spacing.s4, borderRadius: radii.lg, backgroundColor: colors.surfaceRaised },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, minHeight: 32 },
  sep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  collapseHead: { minHeight: 48, flexDirection: 'row', alignItems: 'center' },
  expense: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  row: { flexDirection: 'row', gap: spacing.s2 },
  diff: { flexDirection: 'row', alignItems: 'center', padding: spacing.s3, borderRadius: radii.md },
  blocked: { gap: spacing.s2, padding: spacing.s3, borderRadius: radii.md, backgroundColor: colors.dangerTint },
});
