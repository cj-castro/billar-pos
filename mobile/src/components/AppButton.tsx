import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { colors, radii, spacing, touch, type IconName } from '../theme/tokens';
import { AppText } from './AppText';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'dangerOutline' | 'success';

export interface AppButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  /** md = 48 dp, lg = 56 dp (waiter primary actions). */
  size?: 'md' | 'lg';
  icon?: IconName;
  /** Spinner + blocks presses (idempotency, D6). */
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
}

function palette(variant: ButtonVariant, pressed: boolean, inactive: boolean) {
  if (inactive) return { bg: colors.surfaceRaised, fg: colors.textDisabled, border: 'transparent', opacity: 1 };
  switch (variant) {
    case 'primary':
      return { bg: pressed ? colors.primaryPressed : colors.primary, fg: colors.textOnAccent, border: 'transparent', opacity: 1 };
    case 'secondary':
      return { bg: colors.surfaceRaised, fg: colors.textPrimary, border: colors.textMuted, opacity: pressed ? 0.85 : 1 };
    case 'ghost':
      return { bg: 'transparent', fg: colors.primaryText, border: 'transparent', opacity: pressed ? 0.7 : 1 };
    case 'danger':
      return { bg: pressed ? colors.dangerPressed : colors.danger, fg: colors.textOnDanger, border: 'transparent', opacity: 1 };
    case 'dangerOutline':
      return { bg: 'transparent', fg: colors.dangerText, border: colors.dangerText, opacity: pressed ? 0.85 : 1 };
    case 'success':
      return { bg: colors.success, fg: colors.successTint, border: 'transparent', opacity: pressed ? 0.85 : 1 };
  }
}

export function AppButton({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  icon,
  loading,
  disabled,
  fullWidth,
  style,
  testID,
  accessibilityLabel,
}: AppButtonProps) {
  const inactive = !!(disabled || loading);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: inactive, busy: !!loading }}
      // Not the `disabled` prop: the button stays focusable so screen readers announce its state; presses are ignored.
      onPress={inactive ? undefined : onPress}
      style={({ pressed }) => {
        const p = palette(variant, pressed, inactive);
        return [
          styles.base,
          { minHeight: size === 'lg' ? touch.primary : touch.min, backgroundColor: p.bg, borderColor: p.border, opacity: p.opacity },
          fullWidth && styles.full,
          style,
        ];
      }}
    >
      {({ pressed }) => {
        const fg = palette(variant, pressed, inactive).fg;
        return (
          <View style={styles.row}>
            {loading ? (
              <ActivityIndicator color={fg} size="small" />
            ) : icon ? (
              <MaterialCommunityIcons name={icon} size={22} color={fg} />
            ) : null}
            <AppText variant={size === 'lg' ? 'bodyLg' : 'body'} bold color={fg} numberOfLines={1} style={styles.label}>
              {label}
            </AppText>
          </View>
        );
      }}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radii.md,
    borderWidth: 1.5,
    paddingHorizontal: spacing.s4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  full: { alignSelf: 'stretch' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.s2 },
  label: { flexShrink: 1, textAlign: 'center' },
});
