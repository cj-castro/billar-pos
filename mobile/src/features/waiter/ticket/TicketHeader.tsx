import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useClockOffset } from '../../../api/clockSkew';
import { AppText } from '../../../components/AppText';
import { StatusChip } from '../../../components/StatusChip';
import type { Resource, Ticket } from '../../../domain/types';
import { colors, spacing } from '../../../theme/tokens';
import { formatMXN } from '../../../utils/money';
import { formatClock, formatElapsed } from '../../../utils/time';
import { useNow } from '../../../utils/useNow';
import { poolEstimateCents } from './poolEstimate';
import { activeTimerStart } from './ticketRules';

export interface PoolLive {
  elapsed: string;
  /** null when the table has no pool_config to estimate with. */
  estimateCents: number | null;
}

/** Live "mm:ss" + estimate for a running pool timer (server clock corrected). null when no timer runs. */
export function usePoolLive(ticket: Ticket | undefined, resource: Resource | undefined): PoolLive | null {
  const start = ticket ? activeTimerStart(ticket) : null;
  const offset = useClockOffset((s) => s.offsetMs);
  const now = useNow(undefined, 1000, !!start);
  const startMs = start ? Date.parse(start) : NaN;
  if (Number.isNaN(startMs)) return null;
  const elapsedSeconds = Math.max(0, (now + offset - startMs) / 1000);
  const cfg = resource?.pool_config;
  return {
    elapsed: formatElapsed(elapsedSeconds),
    estimateCents: cfg ? poolEstimateCents({ elapsedSeconds, billingMode: cfg.billing_mode, rateCents: cfg.rate_cents, promoFreeMinutes: cfg.promo_free_minutes }) : null,
  };
}

/** Customer name + opened time, and for POOL a live timer with "≈ $X". The title (table / "Rápido #id") lives in the ScreenHeader. */
export function TicketHeader({ ticket, live, open }: { ticket: Ticket; live: PoolLive | null; open: boolean }) {
  const { t } = useTranslation('mobile');
  const subtitle = [ticket.customer_name, t('waiter.ticket.openedAt', { time: formatClock(new Date(ticket.opened_at)) })].filter(Boolean).join(' · ');
  return (
    <View style={styles.hero}>
      <View style={styles.flex}>
        <AppText variant="label" color={colors.textSecondary} testID="ticket-subtitle">
          {subtitle}
        </AppText>
        {live && (
          <>
            <AppText variant="label" color={colors.textSecondary}>
              {`${t('waiter.ticket.poolTime')} · ${t('waiter.ticket.estimated')}`}
            </AppText>
            <AppText variant="timer" testID="ticket-timer">
              {live.elapsed}
            </AppText>
            {live.estimateCents != null && (
              <AppText variant="bodyLg" bold color={colors.warning} testID="ticket-estimate">
                {`≈ ${formatMXN(live.estimateCents)}`}
              </AppText>
            )}
          </>
        )}
      </View>
      {open && <StatusChip kind="table" status={ticket.payment_requested ? 'BILL_REQUESTED' : 'OCCUPIED'} size="lg" testID="ticket-state" />}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 48 },
});
