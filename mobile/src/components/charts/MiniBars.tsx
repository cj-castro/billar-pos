import { StyleSheet, View } from 'react-native';
import { colors, spacing } from '../../theme/tokens';
import { AppText } from '../AppText';

const HEIGHT = 72;

/** Vertical mini bars (one per value, e.g. 24 hours). `highlight` indices are coloured and labelled below. */
export function MiniBars({ values, highlight = [], labelFor, testID }: { values: number[]; highlight?: number[]; labelFor?: (i: number) => string; testID?: string }) {
  const max = Math.max(0, ...values);
  return (
    <View testID={testID}>
      <View style={styles.bars}>
        {values.map((v, i) => (
          <View
            key={i}
            testID={testID ? `${testID}-${i}` : undefined}
            style={[styles.bar, { height: max > 0 ? Math.max(v > 0 ? 3 : 1, (v / max) * HEIGHT) : 1, backgroundColor: highlight.includes(i) ? colors.primary : colors.surfaceOverlay }]}
          />
        ))}
      </View>
      <View style={styles.labels}>
        {highlight.map((i) => (
          <AppText key={i} variant="caption" color={colors.textSecondary}>
            {labelFor ? labelFor(i) : String(i)}
          </AppText>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bars: { flexDirection: 'row', alignItems: 'flex-end', height: HEIGHT, gap: 2 },
  bar: { flex: 1, borderRadius: 2 },
  labels: { flexDirection: 'row', gap: spacing.s3, marginTop: spacing.s2 },
});
