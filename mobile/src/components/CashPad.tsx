import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { colors, radii, spacing } from '../theme/tokens';
import { haptic } from '../utils/haptics';
import { AppText } from './AppText';

export type CashPadKey = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '00' | 'back';
const KEYS: CashPadKey[] = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'];

/** Unmasked amount keypad (0-9, 00, backspace). PinPad masks its digits, so cash entry needs its own. */
export function CashPad({ onKey, disabled, testID = 'cash-pad' }: { onKey: (k: CashPadKey) => void; disabled?: boolean; testID?: string }) {
  return (
    <View testID={testID} style={styles.pad}>
      {KEYS.map((k) => (
        <Pressable
          key={k}
          testID={`${testID}-${k}`}
          accessibilityRole="button"
          accessibilityLabel={k === 'back' ? '⌫' : k}
          accessibilityState={{ disabled: !!disabled }}
          disabled={disabled}
          onPress={() => {
            haptic.selection();
            onKey(k);
          }}
          style={({ pressed }) => [styles.key, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
        >
          {k === 'back' ? <MaterialCommunityIcons name="backspace-outline" size={24} color={colors.textPrimary} /> : <AppText variant="headline">{k}</AppText>}
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  pad: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  key: { width: '31.5%', height: 52, borderRadius: radii.md, backgroundColor: colors.surfaceOverlay, alignItems: 'center', justifyContent: 'center' },
});
