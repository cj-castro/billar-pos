import { Pressable, StyleSheet } from 'react-native';
import { colors, radii, spacing } from '../theme/tokens';
import { AppText } from './AppText';

/** Selectable pill (filters, option rows); 44 dp tall, selected state announced. */
export function Chip({ label, on, onPress, testID, tab }: { label: string; on: boolean; onPress: () => void; testID?: string; tab?: boolean }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole={tab ? 'tab' : 'button'}
      accessibilityLabel={label}
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.chip, on && styles.on]}
    >
      <AppText variant="body" bold color={on ? colors.textOnAccent : colors.textSecondary}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { minHeight: 44, paddingHorizontal: spacing.s4, borderRadius: radii.pill, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.primary },
});
