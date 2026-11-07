import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, spacing, type DraftStatus } from '../theme/tokens';
import { formatMXN } from '../utils/money';
import { AppButton } from './AppButton';
import { AppText } from './AppText';
import { IconButton } from './IconButton';
import { QuantityStepper } from './QuantityStepper';
import { StatusChip } from './StatusChip';

export interface DraftLineRowProps {
  quantity: number;
  name: string;
  modifiers?: string[];
  note?: string | null;
  status: DraftStatus;
  /** Why it failed ("Agotado", "No se envió"...). */
  errorText?: string | null;
  /** Estimated line total in cents (display only). */
  estimateCents?: number;
  /** Stepper + remove are shown while PENDING / FAILED-and-editable. */
  onQuantityChange?: (q: number) => void;
  onRemove?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
  removeLabel?: string;
  testID?: string;
}

/** Draft order row (SCR-W-05): qty x name, options, note, draft-status chip, stepper / retry. */
export function DraftLineRow({
  quantity,
  name,
  modifiers = [],
  note,
  status,
  errorText,
  estimateCents,
  onQuantityChange,
  onRemove,
  onRetry,
  retryLabel,
  removeLabel,
  testID,
}: DraftLineRowProps) {
  const { t } = useTranslation('mobile');
  const a11y = [`${quantity} ${name}`, ...modifiers, note, t(`status.draft.${status}`), errorText].filter(Boolean).join(', ');
  return (
    <View testID={testID} accessible={false} style={styles.row}>
      <View style={styles.mid} accessible accessibilityLabel={a11y}>
        <AppText variant="bodyLg" bold>
          {`${quantity}× ${name}`}
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
        <View style={styles.chips}>
          <StatusChip kind="draft" status={status} testID={testID ? `${testID}-chip` : undefined} />
          {estimateCents != null && (
            <AppText variant="label" color={colors.textSecondary}>
              {formatMXN(estimateCents)}
            </AppText>
          )}
        </View>
        {!!errorText && (
          <AppText variant="label" bold color={colors.dangerText} testID={testID ? `${testID}-error` : undefined}>
            {errorText}
          </AppText>
        )}
      </View>
      <View style={styles.actions}>
        {status === 'FAILED' && onRetry && <AppButton label={t('retry')} accessibilityLabel={retryLabel} variant="secondary" icon="refresh" onPress={onRetry} testID={testID ? `${testID}-retry` : undefined} />}
        {onQuantityChange && (status === 'PENDING' || status === 'FAILED') && (
          <QuantityStepper value={quantity} size="sm" onChange={onQuantityChange} testID={testID ? `${testID}-qty` : undefined} />
        )}
        {onRemove && status !== 'SENDING' && status !== 'SENT' && (
          <IconButton icon="trash-can-outline" accessibilityLabel={removeLabel ?? t('close')} onPress={onRemove} color={colors.dangerText} testID={testID ? `${testID}-remove` : undefined} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingVertical: spacing.s3,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  mid: { flex: 1, gap: 4 },
  note: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  noteText: { flexShrink: 1 },
  chips: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  actions: { alignItems: 'flex-end', gap: spacing.s2 },
});
