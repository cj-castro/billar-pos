import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, spacing } from '../theme/tokens';
import { AppButton, type AppButtonProps } from './AppButton';
import { AppText } from './AppText';

export interface BottomActionBarProps {
  primary: AppButtonProps;
  secondary?: AppButtonProps;
  /** One line above the buttons: why the primary is disabled (offline, empty, validation). */
  helper?: string;
  testID?: string;
}

/** Pinned action bar; respects the gesture-nav / home-indicator inset. */
export function BottomActionBar({ primary, secondary, helper, testID }: BottomActionBarProps) {
  const insets = useSafeAreaInsets();
  return (
    <View testID={testID} style={[styles.bar, { paddingBottom: Math.max(spacing.s3, insets.bottom) }]}>
      {!!helper && (
        <AppText variant="label" color={colors.textSecondary} style={styles.helper} accessibilityLiveRegion="polite">
          {helper}
        </AppText>
      )}
      <View style={styles.row}>
        {secondary && <AppButton size="lg" variant="secondary" {...secondary} style={[{ flex: 1 }, secondary.style]} />}
        <AppButton size="lg" {...primary} style={[{ flex: secondary ? 1.45 : 1 }, primary.style]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingTop: spacing.s3,
    paddingHorizontal: spacing.s4,
    gap: spacing.s2,
  },
  helper: { textAlign: 'center' },
  row: { flexDirection: 'row', gap: spacing.s2 },
});
