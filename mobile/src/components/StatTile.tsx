import { Pressable, StyleSheet } from 'react-native';
import { colors, radii, spacing } from '../theme/tokens';
import { AppText } from './AppText';

export interface StatTileProps {
  /** null/undefined = endpoint failed: shows "—" (never a stale 0). */
  value: string | number | null | undefined;
  label: string;
  footnote?: string;
  tone?: 'neutral' | 'warning' | 'alert';
  onPress?: () => void;
  testID?: string;
}

const TONE = {
  neutral: { bg: colors.surfaceRaised, fg: colors.textPrimary },
  warning: { bg: colors.warningTint, fg: colors.warning },
  alert: { bg: colors.dangerTint, fg: colors.dangerText },
} as const;

export function StatTile({ value, label, footnote, tone = 'neutral', onPress, testID }: StatTileProps) {
  const c = TONE[tone];
  const shown = value == null ? '—' : String(value);
  return (
    <Pressable
      testID={testID}
      accessibilityRole={onPress ? 'button' : 'summary'}
      accessibilityLabel={`${label}: ${shown}${footnote ? `, ${footnote}` : ''}`}
      onPress={onPress}
      style={({ pressed }) => [styles.tile, { backgroundColor: c.bg, opacity: pressed && onPress ? 0.85 : 1 }]}
    >
      <AppText variant="display" color={c.fg} style={styles.value} numberOfLines={1} adjustsFontSizeToFit>
        {shown}
      </AppText>
      <AppText variant="label" color={colors.textSecondary}>
        {label}
      </AppText>
      {!!footnote && (
        <AppText variant="caption" color={colors.textMuted}>
          {footnote}
        </AppText>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tile: { flex: 1, minHeight: 96, padding: spacing.s4, borderRadius: radii.lg, justifyContent: 'center', gap: 2 },
  value: {},
});
