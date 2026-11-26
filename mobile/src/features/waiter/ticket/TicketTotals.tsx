import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../../components/AppText';
import type { Ticket } from '../../../domain/types';
import { colors, radii, spacing } from '../../../theme/tokens';
import { formatMXN } from '../../../utils/money';

/** Totals card: subtotal, discount (if any), table time, TOTAL (server-authoritative). `running` = pool timer still running (time is an estimate). */
export function TicketTotals({ ticket, running }: { ticket: Ticket; running: boolean }) {
  const { t } = useTranslation('mobile');
  return (
    <View style={styles.card} testID="ticket-totals">
      <Row label={t('waiter.ticket.subtotal')} value={formatMXN(ticket.subtotal_cents)} testID="ticket-subtotal" />
      {ticket.discount_cents > 0 && <Row label={t('waiter.ticket.discount')} value={`-${formatMXN(ticket.discount_cents)}`} color={colors.success} testID="ticket-discount" />}
      {(ticket.pool_time_cents > 0 || running) && (
        <Row
          label={`${t('waiter.ticket.poolTime')}${running ? ` (${t('waiter.ticket.estimated')})` : ''}`}
          value={`${running ? '≈ ' : ''}${formatMXN(ticket.pool_time_cents)}`}
          color={running ? colors.warning : undefined}
          testID="ticket-pool"
        />
      )}
      <View style={styles.totalRow}>
        <AppText variant="bodyLg" bold>
          {t('waiter.ticket.total')}
        </AppText>
        <AppText variant="display" testID="ticket-total">
          {formatMXN(ticket.total_cents)}
        </AppText>
      </View>
      <AppText variant="caption" color={colors.textMuted}>
        {t('waiter.ticket.serverNote')}
      </AppText>
    </View>
  );
}

function Row({ label, value, color, testID }: { label: string; value: string; color?: string; testID: string }) {
  return (
    <View style={styles.row}>
      <AppText variant="body" color={color ?? colors.textSecondary}>
        {label}
      </AppText>
      <AppText variant="body" color={color} testID={testID}>
        {value}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: spacing.s1, padding: spacing.s3, borderRadius: radii.md, backgroundColor: colors.surface },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: spacing.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
