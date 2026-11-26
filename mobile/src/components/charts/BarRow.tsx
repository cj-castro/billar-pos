import { StyleSheet, View } from 'react-native';
import { colors, radii, spacing } from '../../theme/tokens';
import { AppText } from '../AppText';

/** Horizontal bar row: label, bar proportional to value/max, formatted value. No chart lib. */
export function BarRow({ label, value, max, valueLabel, testID }: { label: string; value: number; max: number; valueLabel: string; testID?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <View testID={testID} style={styles.row} accessible accessibilityLabel={`${label}: ${valueLabel}`}>
      <View style={styles.head}>
        <AppText variant="label" style={styles.label} numberOfLines={1}>
          {label}
        </AppText>
        <AppText variant="label" bold>
          {valueLabel}
        </AppText>
      </View>
      <View style={styles.track}>
        <View testID={testID ? `${testID}-fill` : undefined} style={[styles.fill, { width: `${pct}%` }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { gap: 4 },
  head: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.s3 },
  label: { flex: 1 },
  track: { height: 10, borderRadius: radii.sm, backgroundColor: colors.surfaceOverlay, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: colors.primary },
});
