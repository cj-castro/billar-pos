import { useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { getCashSessionSummary, listCashSessions } from '../../../api/endpoints/cash';
import { getEarnings, getEarningsByCategory } from '../../../api/endpoints/earnings';
import {
  getPayments,
  getPeakHours,
  getPoolTime,
  getPromotions,
  getSales,
  getStaff,
  getVoids,
  type DateParams,
} from '../../../api/endpoints/reports';
import { createSafe, deleteSafe, listSafe } from '../../../api/endpoints/safe';
import { qkr } from '../../../api/queryKeys';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { AppTextField } from '../../../components/AppTextField';
import { CashPad } from '../../../components/CashPad';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { StatTile } from '../../../components/StatTile';
import { useToast } from '../../../components/Toast';
import { BarRow } from '../../../components/charts/BarRow';
import { MiniBars } from '../../../components/charts/MiniBars';
import { colors, radii, spacing } from '../../../theme/tokens';
import { errorMessage } from '../../../utils/errorMessage';
import { formatMXN } from '../../../utils/money';
import { formatClock } from '../../../utils/time';
import { SheetModal } from '../../common/SheetModal';
import { applyPadKey } from '../../waiter/pay/payModel';
import { groupByCategory, hoursFromSeconds, paymentsSummary, peakHours, salesTotal, voidsSummary } from './reportsModel';

const useRep = <T,>(name: string, fn: (p: DateParams) => Promise<T>, r: DateParams) => useQuery({ queryKey: qkr.report(name, r), queryFn: () => fn(r) });

export function Card({ title, testID, children }: { title: string; testID: string; children: ReactNode }) {
  return (
    <View style={styles.card} testID={testID}>
      <AppText variant="title" bold accessibilityRole="header">
        {title}
      </AppText>
      {children}
    </View>
  );
}

/** Loading / error / empty / data states for one card. */
function Body<T>({ q, isEmpty, children }: { q: UseQueryResult<T>; isEmpty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  const { t } = useTranslation('mobile');
  if (q.isPending) return <ActivityIndicator color={colors.primaryText} />;
  if (q.isError)
    return (
      <View style={styles.gap}>
        <AppText variant="body" color={colors.dangerText}>
          {errorMessage(q.error)}
        </AppText>
        <AppButton label={t('reports.retry')} variant="secondary" onPress={() => void q.refetch()} />
      </View>
    );
  if (isEmpty?.(q.data)) return <AppText color={colors.textMuted}>{t('reports.noData')}</AppText>;
  return <>{children(q.data)}</>;
}

const Line = ({ left, right, sub, tone }: { left: string; right?: string; sub?: string; tone?: string }) => (
  <View style={styles.line}>
    <View style={styles.flex}>
      <AppText variant="body">{left}</AppText>
      {!!sub && (
        <AppText variant="caption" color={colors.textMuted}>
          {sub}
        </AppText>
      )}
    </View>
    {!!right && (
      <AppText variant="body" bold color={tone ?? colors.textPrimary}>
        {right}
      </AppText>
    )}
  </View>
);

export function SalesCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const sales = useRep('sales', getSales, r);
  const pay = useRep('payments', getPayments, r);
  const ps = pay.data ? paymentsSummary(pay.data) : null;
  return (
    <Card title={t('reports.cards.sales')} testID="card-sales">
      <View style={styles.tiles}>
        <StatTile testID="tile-total" label={t('reports.total')} value={sales.data ? formatMXN(salesTotal(sales.data)) : null} />
        <StatTile testID="tile-tickets" label={t('reports.tickets')} value={ps ? ps.tickets : null} />
      </View>
      <View style={styles.tiles}>
        <StatTile label={t('reports.avgTicket')} value={ps ? formatMXN(ps.avgCents) : null} />
        <StatTile label={t('reports.tips')} value={ps ? formatMXN(ps.tipsCents) : null} />
      </View>
      <Body q={pay} isEmpty={(d) => d.length === 0}>
        {(rows) => (
          <View style={styles.gap}>
            <AppText variant="label" color={colors.textSecondary}>
              {t('reports.byMethod')}
            </AppText>
            {rows.map((p) => (
              <Line key={p.payment_type} left={t(`reports.method.${p.payment_type}`, { defaultValue: p.payment_type })} sub={t('reports.ticketsCount', { n: p.ticket_count })} right={formatMXN(p.total_cents)} />
            ))}
          </View>
        )}
      </Body>
    </Card>
  );
}

export function CategoryCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const q = useRep('sales', getSales, r);
  return (
    <Card title={t('reports.cards.byCategory')} testID="card-category">
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) => {
          const g = groupByCategory(rows);
          const max = Math.max(...g.map((x) => x.cents));
          return (
            <View style={styles.gap}>
              {g.map((x) => (
                <BarRow key={x.category} testID={`bar-${x.category}`} label={x.category} value={x.cents} max={max} valueLabel={formatMXN(x.cents)} />
              ))}
            </View>
          );
        }}
      </Body>
    </Card>
  );
}

export function StaffCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const q = useRep('staff', getStaff, r);
  return (
    <Card title={t('reports.cards.byStaff')} testID="card-staff">
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) =>
          rows.map((s) => (
            <Line key={s.user_id} left={s.staff_name} sub={`${t('reports.ticketsCount', { n: s.tickets_closed })} · ${t('reports.tips')} ${formatMXN(s.total_tips_cents)}`} right={formatMXN(s.total_sales_cents)} />
          ))
        }
      </Body>
    </Card>
  );
}

export function PoolCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const q = useRep('pool', getPoolTime, r);
  return (
    <Card title={t('reports.cards.pool')} testID="card-pool">
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) => (
          <>
            <View style={styles.tiles}>
              <StatTile label={t('reports.hoursSold')} value={t('reports.hours', { h: hoursFromSeconds(rows.reduce((s, x) => s + x.total_seconds, 0)) })} testID="tile-pool-hours" />
              <StatTile label={t('reports.income')} value={formatMXN(rows.reduce((s, x) => s + x.revenue_cents, 0))} />
            </View>
            {rows.map((x) => (
              <Line key={x.table_code} left={x.table_code} sub={`${t('reports.hours', { h: hoursFromSeconds(x.total_seconds) })} · ${t('reports.sessionsCount', { n: x.sessions })}`} right={formatMXN(x.revenue_cents)} />
            ))}
          </>
        )}
      </Body>
    </Card>
  );
}

export function PeakCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const q = useRep('peak', getPeakHours, r);
  return (
    <Card title={t('reports.cards.peak')} testID="card-peak">
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) => {
          const { values, top3 } = peakHours(rows);
          return <MiniBars testID="peak-bars" values={values} highlight={top3} labelFor={(h) => `${t('reports.peakHour', { h })} · ${formatMXN(values[h])}`} />;
        }}
      </Body>
    </Card>
  );
}

export function VoidsCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const q = useRep('voids', getVoids, r);
  return (
    <Card title={t('reports.cards.voids')} testID="card-voids">
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) => {
          const s = voidsSummary(rows);
          return (
            <>
              <View style={styles.tiles}>
                <StatTile testID="tile-voids-count" label={t('reports.voidsCount')} value={s.count} tone="warning" />
                <StatTile testID="tile-voids-total" label={t('reports.voidsTotal')} value={formatMXN(s.totalCents)} tone="warning" />
              </View>
              {rows.slice(0, 20).map((v, i) => (
                <Line
                  key={`${v.ticket_id}-${i}`}
                  left={`${v.quantity}× ${v.item_name}${v.table_code ? ` · ${v.table_code}` : ''}`}
                  sub={`${t('reports.voidLine', { who: v.voided_by ?? v.ticket_opened_by ?? t('reports.unknown'), reason: v.reason ?? t('reports.unknown') })}${v.voided_at ? ` · ${formatClock(new Date(v.voided_at))}` : ''}`}
                  right={formatMXN(v.quantity * v.unit_price_cents)}
                />
              ))}
            </>
          );
        }}
      </Body>
    </Card>
  );
}

export function PromosCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const q = useRep('promos', getPromotions, r);
  return (
    <Card title={t('reports.cards.promos')} testID="card-promos">
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) =>
          rows.map((p) => <Line key={p.promotion_id} left={p.promotion_name} sub={t('reports.uses', { n: p.applications })} right={`-${formatMXN(p.discount_cents)}`} />)
        }
      </Body>
    </Card>
  );
}

export function EarningsCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const q = useRep('earnings', getEarnings, r);
  const cat = useRep('earnings-cat', getEarningsByCategory, r);
  return (
    <Card title={t('reports.cards.earnings')} testID="card-earnings">
      <Body q={q}>
        {(e) => (
          <>
            <View style={styles.tiles}>
              <StatTile label={t('reports.income')} value={formatMXN(e.ingresos_cents)} />
              <StatTile label={t('reports.cost')} value={formatMXN(e.cogs_cents)} />
            </View>
            <View style={styles.tiles}>
              <StatTile testID="tile-profit" label={t('reports.profit')} value={formatMXN(e.ganancia_cents)} />
              <StatTile label={t('reports.margin')} value={e.margen_pct == null ? null : `${e.margen_pct}%`} />
            </View>
            {!!e.items_sin_costo_count && (
              <AppText variant="caption" color={colors.warning}>
                {t('reports.noCost', { n: e.items_sin_costo_count })}
              </AppText>
            )}
          </>
        )}
      </Body>
      {cat.data?.rows?.map((c) => <Line key={c.category} left={c.category} sub={`${t('reports.income')} ${formatMXN(c.ingresos_cents)}`} right={formatMXN(c.ganancia_cents)} />)}
    </Card>
  );
}

export function SafeCard({ r }: { r: DateParams }) {
  const { t } = useTranslation('mobile');
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qkr.safe(r), queryFn: () => listSafe(r) });
  const [open, setOpen] = useState(false);
  const [cents, setCents] = useState(0);
  const [notes, setNotes] = useState('');
  const [del, setDel] = useState<string | null>(null);
  const done = (title: string) => {
    toast.show({ tone: 'success', title });
    void qc.invalidateQueries({ queryKey: ['safe'] });
  };
  const fail = (e: unknown) => toast.show({ tone: 'error', title: t('reports.safeFailed'), message: errorMessage(e) });
  const add = useMutation({
    mutationFn: () => createSafe({ amount_cents: cents, notes: notes.trim() }),
    onSuccess: () => {
      setOpen(false);
      setCents(0);
      setNotes('');
      done(t('reports.safeSaved'));
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteSafe(id),
    onSuccess: () => {
      setDel(null);
      done(t('reports.safeDeleted'));
    },
    onError: (e) => {
      setDel(null);
      fail(e);
    },
  });
  return (
    <Card title={t('reports.cards.safe')} testID="card-safe">
      <AppButton testID="safe-add" label={`+ ${t('reports.safeAdd')}`} variant="secondary" fullWidth onPress={() => setOpen(true)} />
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) =>
          rows.map((s) => (
            <View key={s.id} style={styles.line}>
              <View style={styles.flex}>
                <AppText variant="body" bold>
                  {formatMXN(s.amount_cents)}
                </AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  {`${s.collector_name ?? s.collector_username ?? t('reports.unknown')} · ${formatClock(new Date(s.created_at))}${s.notes ? ` · ${s.notes}` : ''}`}
                </AppText>
              </View>
              <AppButton testID={`safe-delete-${s.id}`} label={t('reports.safeDelete')} variant="dangerOutline" onPress={() => setDel(s.id)} />
            </View>
          ))
        }
      </Body>
      <SheetModal visible={open} onClose={add.isPending ? undefined : () => setOpen(false)} testID="safe-sheet">
        <View style={styles.gap}>
          <AppText variant="headline">{t('reports.safeAdd')}</AppText>
          <AppText variant="display" testID="safe-amount">
            {formatMXN(cents)}
          </AppText>
          <CashPad onKey={(k) => setCents((c) => applyPadKey(c, k))} testID="safe-pad" />
          <AppTextField label={t('reports.safeNotes')} value={notes} onChangeText={setNotes} autoCapitalize="sentences" testID="safe-notes" />
          <AppButton testID="safe-save" label={t('reports.safeSave')} fullWidth disabled={cents <= 0} loading={add.isPending} onPress={() => add.mutate()} />
        </View>
      </SheetModal>
      <ConfirmDialog
        visible={del !== null}
        destructive
        title={t('reports.safeDeleteTitle')}
        confirmLabel={t('reports.safeDelete')}
        cancelLabel={t('cancel')}
        loading={remove.isPending}
        onConfirm={() => del && remove.mutate(del)}
        onCancel={() => setDel(null)}
      />
    </Card>
  );
}

export function SessionsCard() {
  const { t } = useTranslation('mobile');
  const q = useQuery({ queryKey: qkr.cashSessions, queryFn: listCashSessions });
  // The list has no totals, so fetch the summary of the 10 most recent closed sessions.
  const closed = (q.data ?? []).filter((s) => s.status === 'CLOSED').slice(0, 10);
  const sums = useQueries({ queries: closed.map((s) => ({ queryKey: qkr.cashSummary(s.id), queryFn: () => getCashSessionSummary(s.id), staleTime: 5 * 60_000 })) });
  return (
    <Card title={t('reports.cards.sessions')} testID="card-sessions">
      <Body q={q} isEmpty={(d) => d.length === 0}>
        {(rows) =>
          rows.slice(0, 10).map((s) => {
            const i = closed.findIndex((c) => c.id === s.id);
            const sm = i >= 0 ? sums[i]?.data?.summary : undefined;
            const diff = sm?.cash_over_short_cents;
            return (
              <Line
                key={s.id}
                left={s.date ?? '—'}
                sub={s.status === 'OPEN' ? t('reports.sessionsOpen') : `${t('reports.sessionsSales')} ${sm ? formatMXN(sm.total_sales_cents) : '…'}`}
                right={diff == null ? undefined : `${t('reports.sessionsDiff')} ${formatMXN(diff)}`}
                tone={diff == null ? undefined : diff === 0 ? colors.success : diff < 0 ? colors.dangerText : colors.warning}
              />
            );
          })
        }
      </Body>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: spacing.s4, gap: spacing.s3 },
  gap: { gap: spacing.s3 },
  flex: { flex: 1 },
  tiles: { flexDirection: 'row', gap: spacing.s3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 44 },
});
