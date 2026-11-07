import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, radii, spacing } from '../theme/tokens';
import { formatMXN } from '../utils/money';
import { AppText } from './AppText';

export interface MenuItemTileProps {
  name: string;
  priceCents: number;
  routing?: 'KITCHEN' | 'BAR' | null;
  soldOut?: boolean;
  /** Quantity already in the draft (shows a badge + primary border). */
  draftQty?: number;
  onPress?: () => void;
  /** Long-press opens the configurator even for items without options. */
  onLongPress?: () => void;
  /** One-line chip (the "Frecuentes" row). */
  compact?: boolean;
  testID?: string;
}

export function MenuItemTile({ name, priceCents, soldOut, draftQty = 0, compact, onPress, onLongPress, testID }: MenuItemTileProps) {
  const { t } = useTranslation('mobile');
  const inDraft = draftQty > 0 && !soldOut;
  const label = [name, soldOut ? t('menu.soldOutA11y') : formatMXN(priceCents), inDraft ? t('menu.inDraft', { n: draftQty }) : null].filter(Boolean).join(', ');
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!soldOut }}
      onPress={soldOut ? undefined : onPress}
      onLongPress={soldOut ? undefined : onLongPress}
      style={({ pressed }) => [
        styles.tile,
        compact && styles.compact,
        soldOut && styles.soldOut,
        inDraft && styles.inDraft,
        { opacity: pressed && !soldOut ? 0.85 : 1 },
      ]}
    >
      <AppText variant="body" bold color={soldOut ? colors.textMuted : colors.textPrimary} numberOfLines={2}>
        {name}
      </AppText>
      {soldOut ? (
        <AppText variant="label" bold color={colors.dangerText}>
          {t('menu.soldOut')}
        </AppText>
      ) : (
        <AppText variant="label" color={colors.textSecondary}>
          {formatMXN(priceCents)}
        </AppText>
      )}
      {inDraft && (
        <View style={styles.badge} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <AppText variant="caption" bold color={colors.textOnAccent}>
            {draftQty}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minHeight: 92,
    padding: spacing.s3,
    gap: spacing.s1,
    justifyContent: 'space-between',
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  compact: { flex: 0, minHeight: 48, width: 132, padding: spacing.s2, justifyContent: 'center', gap: 0 },
  soldOut: { backgroundColor: colors.surface, borderColor: colors.border, borderStyle: 'dashed' },
  inDraft: { borderColor: colors.primary },
  badge: {
    position: 'absolute',
    top: 6,
    right: 6,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
