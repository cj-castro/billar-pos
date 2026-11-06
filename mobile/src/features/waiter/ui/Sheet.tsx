import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Keyboard, Pressable, StyleSheet, View } from 'react-native';
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
  const root = useRef<React.ComponentRef<typeof View>>(null);
  // Edge-to-edge Android does not always resize the window, so lift the sheet by however much of the root the keyboard covers
  // (0 when the window already resized).
  const [lift, setLift] = useState(0);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', (e) =>
      root.current?.measureInWindow((_x, y, _w, h) => setLift(Math.max(0, Math.round(y + h - e.endCoordinates.screenY)))),
    );
    const hide = Keyboard.addListener('keyboardDidHide', () => setLift(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return (
    <View ref={root} style={[styles.root, { paddingBottom: lift }]}>
      <Pressable testID={`${testID}-scrim`} accessible={false} style={styles.scrim} onPress={onClose} />
      <View testID={testID} accessibilityViewIsModal style={[styles.sheet, { paddingBottom: lift ? spacing.s3 : Math.max(spacing.s4, insets.bottom) }]}>
        <View style={styles.grabber} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
        {children}
      </View>
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
