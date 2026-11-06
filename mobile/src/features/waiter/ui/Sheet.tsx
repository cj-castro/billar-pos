import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, elevation, radii, spacing } from '../../../theme/tokens';

export interface SheetProps {
  children: ReactNode;
  /** Scrim tap / hardware back. Omit to make the sheet non-dismissible (request in flight). */
  onClose?: () => void;
  testID?: string;
}

/** Bottom sheet body for `transparentModal` routes (open-table, configurator): scrim + rounded card. */
export function Sheet({ children, onClose, testID = 'sheet' }: SheetProps) {
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.root}>
      <Pressable testID={`${testID}-scrim`} accessible={false} style={styles.scrim} onPress={onClose} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} pointerEvents="box-none">
        <View testID={testID} accessibilityViewIsModal style={[styles.sheet, { paddingBottom: Math.max(spacing.s4, insets.bottom) }]}>
          <View style={styles.grabber} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
          {children}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  scrim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.62)' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.xl,
    borderTopRightRadius: radii.xl,
    paddingHorizontal: spacing.s4,
    paddingTop: spacing.s2,
    gap: spacing.s3,
    maxHeight: '92%',
    elevation: elevation.e3,
  },
  grabber: { alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.textMuted, marginBottom: spacing.s1 },
});
