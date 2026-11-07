import { MaterialCommunityIcons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';
import { colors, spacing, type IconName } from '../theme/tokens';
import { AppButton } from './AppButton';
import { AppText } from './AppText';

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  message?: string;
  action?: { label: string; onPress: () => void };
  /** Icon disc colours (ErrorState reuses this layout). */
  tone?: 'neutral' | 'warning' | 'danger';
  testID?: string;
}

const TONE = {
  neutral: { bg: colors.surfaceRaised, fg: colors.textSecondary },
  warning: { bg: colors.warningTint, fg: colors.warning },
  danger: { bg: colors.dangerTint, fg: colors.dangerText },
} as const;

export function EmptyState({ icon, title, message, action, tone = 'neutral', testID }: EmptyStateProps) {
  const c = TONE[tone];
  return (
    <View testID={testID} style={styles.wrap}>
      <View style={[styles.disc, { backgroundColor: c.bg }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
        <MaterialCommunityIcons name={icon} size={44} color={c.fg} />
      </View>
      <AppText variant="headline" style={styles.center} accessibilityRole="header">
        {title}
      </AppText>
      {!!message && (
        <AppText variant="body" color={colors.textSecondary} style={styles.center}>
          {message}
        </AppText>
      )}
      {action && <AppButton size="lg" label={action.label} onPress={action.onPress} testID={testID ? `${testID}-action` : undefined} />}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.s3, padding: spacing.s6 },
  disc: { width: 88, height: 88, borderRadius: 44, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.s2 },
  center: { textAlign: 'center' },
});
