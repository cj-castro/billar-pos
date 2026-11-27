import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../../components/AppText';
import { AppTextField } from '../../../components/AppTextField';
import { colors, spacing } from '../../../theme/tokens';
import { formatMXN } from '../../../utils/money';
import { denomValue, parseQty, totalCents, type CountLines, type Denom } from './cashModel';

/**
 * One whole-number field per denomination. `max` (optional) caps each row, used by the
 * "what stays in the drawer" grid (a row can not be more than what was counted).
 * Text that is not a whole number is ignored (the previous value stays).
 */
export function CountGrid({ denoms, lines, onChange, max, testIDPrefix, totalLabel }: { denoms: readonly Denom[]; lines: CountLines; onChange: (next: CountLines) => void; max?: CountLines; testIDPrefix: string; totalLabel: string }) {
  const { t } = useTranslation('mobile');
  const set = (key: string, text: string) => {
    const q = parseQty(text);
    if (q == null) return;
    const capped = max ? Math.min(q, max[key] || 0) : q;
    const next = { ...lines };
    if (capped > 0) next[key] = capped;
    else delete next[key];
    onChange(next);
  };
  const total = formatMXN(totalCents(lines, denoms));
  return (
    <View style={styles.grid}>
      {denoms.map((d) => (
        <AppTextField
          key={d.key}
          label={t(d.kind === 'COIN' ? 'mgr.cash.count.coin' : 'mgr.cash.count.bill', { value: denomValue(d.cents) })}
          value={lines[d.key] ? String(lines[d.key]) : ''}
          placeholder="0"
          onChangeText={(v) => set(d.key, v)}
          keyboardType="number-pad"
          testID={`${testIDPrefix}-${d.key}`}
        />
      ))}
      <View style={styles.total} testID={`${testIDPrefix}-total`} accessible accessibilityLabel={`${totalLabel}: ${total}`}>
        <AppText variant="title" style={styles.flex}>
          {totalLabel}
        </AppText>
        <AppText variant="title" bold>
          {total}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { gap: spacing.s2 },
  flex: { flex: 1 },
  total: { flexDirection: 'row', alignItems: 'center', paddingTop: spacing.s2, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
});
