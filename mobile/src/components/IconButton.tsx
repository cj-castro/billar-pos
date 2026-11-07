import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet } from 'react-native';
import { colors, touch, type IconName } from '../theme/tokens';

export interface IconButtonProps {
  icon: IconName;
  /** Required: icon-only control. */
  accessibilityLabel: string;
  onPress?: () => void;
  tonal?: boolean;
  disabled?: boolean;
  color?: string;
  size?: number;
  testID?: string;
}

export function IconButton({ icon, accessibilityLabel, onPress, tonal, disabled, color = colors.textPrimary, size = 24, testID }: IconButtonProps) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      hitSlop={touch.hitSlop}
      onPress={disabled ? undefined : onPress}
      style={({ pressed }) => [styles.base, tonal && { backgroundColor: colors.surfaceRaised }, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
    >
      <MaterialCommunityIcons name={icon} size={size} color={color} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { width: touch.iconButton, height: touch.iconButton, borderRadius: touch.iconButton / 2, alignItems: 'center', justifyContent: 'center' },
});
