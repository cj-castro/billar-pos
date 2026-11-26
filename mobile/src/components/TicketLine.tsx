import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, radii, spacing, type LineStatus } from '../theme/tokens';
import { formatMXN } from '../utils/money';
import { AppText } from './AppText';
import { StatusChip } from './StatusChip';

export interface TicketLineProps {
  quantity: number;
  name: string;
  modifiers?: string[];
  note?: string | null;
  status: LineStatus;
  netCents: number;
  promoLabel?: string | null;
  onPress?: () => void;
  /** Manager menu (P1). */
  onLongPress?: () => void;
  testID?: string;
}

export function TicketLine({ quantity, name, modifiers = [], note, status, netCents, promoLabel, onPress, onLongPress, testID }: TicketLineProps) {
  const { t } = useTranslation('mobile');
  const voided = status === 'VOIDED';
  const served = status === 'SERVED';
  const strike = voided ? ({ textDecorationLine: 'line-through' } as const) : null;
  const price = formatMXN(netCents);
  const a11y = [`${quantity} ${name}`, ...modifiers, note, t(`status.item.${status}`), price].filter(Boolean).join(', ');
  return (
    <Pressable
      testID={testID}
      accessible
      accessibilityRole={onPress || onLongPress ? 'button' : 'text'}
      accessibilityLabel={a11y}
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [styles.row, { opacity: pressed && (onPress || onLongPress) ? 0.85 : 1 }]}
    >
      <AppText variant="bodyLg" color={colors.primaryText} style={styles.qty}>
        {quantity}×
      </AppText>
      <View style={styles.mid}>
        <AppText variant="body" bold color={served || voided ? colors.textSecondary : colors.textPrimary} style={strike}>
          {name}
        </AppText>
        {modifiers.length > 0 && (
          <AppText variant="label" color={colors.textSecondary}>
            {modifiers.join(' · ')}
          </AppText>
        )}
        {!!note && (
          <View style={styles.note}>
            <MaterialCommunityIcons name="note-text-outline" size={16} color={colors.warning} />
            <AppText variant="label" bold color={colors.warning} style={styles.noteText}>
              {note}
            </AppText>
          </View>
        )}
        {!!promoLabel && (
          <AppText variant="caption" color={colors.success}>
            {promoLabel}
          </AppText>
        )}
      </View>
      <View style={styles.right}>
        <AppText variant="body" bold style={strike}>
          {price}
        </AppText>
        <StatusChip kind="item" status={status} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: 'row',
    gap: spacing.s3,
    paddingVertical: spacing.s3,
    paddingHorizontal: spacing.s4,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
  },
  qty: { minWidth: 36, fontWeight: '700' },
  mid: { flex: 1, gap: 2 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  noteText: { flexShrink: 1 },
  right: { alignItems: 'flex-end', gap: spacing.s1 },
});
