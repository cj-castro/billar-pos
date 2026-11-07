import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { AppText } from '../../../components/AppText';
import { colors, radii, spacing, type IconName } from '../../../theme/tokens';

export interface ActionRow {
  icon: IconName;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  danger?: boolean;
  testID: string;
}

/** "Más acciones": full-width list rows (icon + label + chevron), 56 dp touch targets. */
export function TicketMoreActions({ title, rows }: { title: string; rows: (ActionRow | null | false | undefined)[] }) {
  const items = rows.filter((r): r is ActionRow => !!r);
  return (
    <View style={styles.wrap}>
      <AppText variant="label" bold color={colors.textSecondary}>
        {title}
      </AppText>
      <View style={styles.list}>
        {items.map((r) => {
          const off = !!r.disabled || !!r.loading;
          const fg = r.danger ? colors.dangerText : off ? colors.textDisabled : colors.textPrimary;
          return (
            <Pressable
              key={r.testID}
              testID={r.testID}
              accessibilityRole="button"
              accessibilityLabel={r.label}
              accessibilityState={{ disabled: off }}
              disabled={off}
              onPress={r.onPress}
              style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
            >
              <MaterialCommunityIcons name={r.icon} size={22} color={fg} />
              <AppText variant="body" color={fg} style={styles.label}>
                {r.label}
              </AppText>
              {r.loading ? <ActivityIndicator color={colors.textSecondary} /> : <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s2, paddingTop: spacing.s2 },
  list: { borderRadius: radii.md, backgroundColor: colors.surface, overflow: 'hidden' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.s3, paddingHorizontal: spacing.s3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  label: { flex: 1 },
});
