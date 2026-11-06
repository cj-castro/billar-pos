import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ageStyle, colors, fontSizesKds, kdsAgeLevel, radii, spacing, touch } from '../theme/tokens';
import { useNow } from '../utils/useNow';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { KdsAgeBadge } from './KdsAgeBadge';

export type KdsItemStatus = 'SENT' | 'IN_PROGRESS' | 'READY';

export interface KdsItem {
  id: string;
  quantity: number;
  name: string;
  modifiers?: string[];
  note?: string | null;
  status: KdsItemStatus;
}

export interface KdsTicket {
  code: string;
  customerName?: string | null;
  items: KdsItem[];
  /** ISO sent_at of the oldest un-READY item. */
  oldestSentAt: string;
}

export interface KdsTicketCardProps {
  ticket: KdsTicket;
  /** Advances exactly one step (SENT -> IN_PROGRESS -> READY); the client enforces the order. */
  onAdvanceItem: (itemId: string) => void;
  onAllReady: () => void;
  /** Optional explicit READY -> SERVED action, shown only when every item is READY. */
  onServed?: () => void;
  servedLabel?: string;
  /** Item ids with a request in flight. */
  advancingIds?: readonly string[];
  landscape?: boolean;
  /** Override "now" (tests). */
  now?: number;
  testID?: string;
}

const STRIPE = { SENT: colors.surfaceOverlay, IN_PROGRESS: colors.warning, READY: colors.success } as const;

export function KdsItemRow({ item, busy, onAdvance }: { item: KdsItem; busy?: boolean; onAdvance: () => void }) {
  const { t } = useTranslation('mobile');
  const done = item.status === 'READY';
  const actionLabel = item.status === 'SENT' ? t('kds.start') : item.status === 'IN_PROGRESS' ? t('kds.ready') : t('kds.done');
  const a11y = [`${item.quantity} ${item.name}`, ...(item.modifiers ?? []), item.note, t(`status.item.${item.status}`), actionLabel].filter(Boolean).join(', ');
  return (
    <Pressable
      testID={`kds-item-${item.id}`}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled: done || !!busy, busy: !!busy }}
      onPress={done || busy ? undefined : onAdvance}
      style={({ pressed }) => [styles.row, { opacity: pressed ? 0.85 : done ? 0.7 : 1 }]}
    >
      <View style={[styles.stripe, { backgroundColor: STRIPE[item.status] }]} />
      <AppText variant="headline" bold fixedScale color={colors.primaryText} style={styles.qty}>
        {item.quantity}
      </AppText>
      <View style={styles.mid}>
        <AppText variant="title" bold fixedScale style={{ fontSize: fontSizesKds.item, lineHeight: 28 }}>
          {item.name}
        </AppText>
        {(item.modifiers ?? []).map((m, i) => (
          <AppText key={i} variant="body" fixedScale color={colors.textSecondary} style={{ fontSize: fontSizesKds.modifier }}>
            {m}
          </AppText>
        ))}
        {!!item.note && (
          <View style={styles.note}>
            <MaterialCommunityIcons name="note-text-outline" size={20} color={colors.textOnAccent} />
            <AppText variant="body" bold fixedScale color={colors.textOnAccent} style={{ fontSize: fontSizesKds.note, flexShrink: 1 }}>
              {item.note}
            </AppText>
          </View>
        )}
      </View>
      <View style={[styles.action, item.status === 'IN_PROGRESS' && styles.actionPrimary, done && styles.actionDone]} pointerEvents="none">
        {busy ? (
          <ActivityIndicator color={colors.textPrimary} />
        ) : (
          <AppText variant="body" bold fixedScale color={item.status === 'IN_PROGRESS' ? colors.textOnAccent : done ? colors.successTint : colors.textPrimary}>
            {actionLabel}
          </AppText>
        )}
      </View>
    </Pressable>
  );
}

export function KdsTicketCard({ ticket, onAdvanceItem, onAllReady, onServed, servedLabel, advancingIds = [], landscape, now, testID }: KdsTicketCardProps) {
  const { t } = useTranslation('mobile');
  const since = new Date(ticket.oldestSentAt).getTime();
  const clock = useNow(now);
  const minutes = (clock - since) / 60000;
  const border = ageStyle(kdsAgeLevel(Number.isNaN(minutes) ? 0 : minutes));
  const allReady = ticket.items.length > 0 && ticket.items.every((i) => i.status === 'READY');
  return (
    <View testID={testID ?? `kds-card-${ticket.code}`} style={[styles.card, { borderColor: border.border, borderWidth: border.borderWidth }, landscape && styles.landscape]}>
      <View style={styles.header}>
        <View style={styles.headLeft}>
          <AppText variant="display" bold fixedScale style={{ fontSize: fontSizesKds.ticketCode, lineHeight: 38 }} numberOfLines={1}>
            {ticket.code}
          </AppText>
          {!!ticket.customerName && (
            <AppText variant="body" fixedScale color={colors.textSecondary} numberOfLines={1} style={{ fontSize: fontSizesKds.meta }}>
              {ticket.customerName}
            </AppText>
          )}
        </View>
        <KdsAgeBadge since={ticket.oldestSentAt} now={now} />
      </View>
      {ticket.items.map((i) => (
        <KdsItemRow key={i.id} item={i} busy={advancingIds.includes(i.id)} onAdvance={() => onAdvanceItem(i.id)} />
      ))}
      <View style={styles.footer}>
        {allReady ? (
          <>
            <AppText variant="body" bold color={colors.textMuted} style={styles.waiting}>
              {t('kds.waiting')}
            </AppText>
            {onServed && <AppButton label={servedLabel ?? 'OK'} variant="success" size="lg" fullWidth onPress={onServed} testID={`kds-served-${ticket.code}`} />}
          </>
        ) : (
          <AppButton label={t('kds.allReady')} variant="secondary" size="lg" fullWidth onPress={onAllReady} testID={`kds-all-ready-${ticket.code}`} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, overflow: 'hidden' },
  landscape: { width: 286 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.s2, padding: spacing.s3, backgroundColor: colors.surfaceRaised },
  headLeft: { flex: 1 },
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.s3, paddingRight: spacing.s3, paddingVertical: spacing.s2 },
  stripe: { width: 8, alignSelf: 'stretch' },
  qty: { minWidth: 30, fontSize: fontSizesKds.itemQty, lineHeight: 32 },
  mid: { flex: 1, gap: 2 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start', backgroundColor: colors.warning, borderRadius: radii.sm, paddingHorizontal: 8, paddingVertical: 4, marginTop: 4 },
  action: { minWidth: 84, height: touch.primary, paddingHorizontal: spacing.s3, borderRadius: radii.md, borderWidth: 1.5, borderColor: colors.textMuted, alignItems: 'center', justifyContent: 'center' },
  actionPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  actionDone: { backgroundColor: colors.success, borderColor: colors.success },
  footer: { padding: spacing.s3 },
  waiting: { textAlign: 'center', paddingVertical: spacing.s3 },
});
