import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, radii, spacing } from '../theme/tokens';
import { haptic } from '../utils/haptics';
import { formatMXN } from '../utils/money';
import { toggleModifier, validateModifierSelection, type ModifierRule } from '../utils/modifiers';
import { AppText } from './AppText';

export interface ModifierOption {
  id: string;
  name: string;
  priceDeltaCents: number;
  /** Out of stock etc. */
  disabled?: boolean;
}

export interface ModifierGroupProps {
  title: string;
  mandatory: boolean;
  min: number;
  max: number;
  allowMultiple: boolean;
  options: ModifierOption[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Show the validation error (the parent decides when, e.g. after a failed "Agregar"). */
  showError?: boolean;
  testID?: string;
}

export function ModifierGroup({ title, mandatory, min, max, allowMultiple, options, selectedIds, onChange, showError, testID }: ModifierGroupProps) {
  const { t } = useTranslation('mobile');
  const rule: ModifierRule = { isMandatory: mandatory, min, max, allowMultiple };
  const v = validateModifierSelection(rule, selectedIds.length);
  const multi = allowMultiple;

  const badge = v.required
    ? Number.isFinite(v.max) && v.max !== v.min
      ? t('modifier.requiredRange', { min: v.min, max: v.max })
      : t('modifier.required', { n: v.min })
    : Number.isFinite(v.max) && v.max > 1
      ? t('modifier.optionalUpTo', { max: v.max })
      : t('modifier.optional');

  const footer =
    multi && Number.isFinite(v.max)
      ? `${t('modifier.selectedOf', { n: v.count, max: v.max })}${v.canAddMore ? '' : ` · ${t('modifier.removeOne')}`}`
      : null;
  const error = showError && v.error ? (v.error === 'min' ? t('modifier.minError', { min: v.min }) : t('modifier.maxError', { max: v.max })) : null;

  return (
    <View testID={testID} style={styles.group}>
      <View style={styles.header}>
        <AppText variant="bodyLg" bold style={styles.title}>
          {title}
        </AppText>
        <View style={[styles.badge, { backgroundColor: v.required ? colors.warningTint : colors.surfaceOverlay }]}>
          <AppText variant="caption" bold color={v.required ? colors.warning : colors.textSecondary}>
            {badge}
          </AppText>
        </View>
      </View>
      {options.map((o) => {
        const selected = selectedIds.includes(o.id);
        const blocked = o.disabled || (!selected && multi && !v.canAddMore);
        const icon = multi
          ? selected ? 'checkbox-marked' : 'checkbox-blank-outline'
          : selected ? 'radiobox-marked' : 'radiobox-blank';
        return (
          <Pressable
            key={o.id}
            testID={testID ? `${testID}-${o.id}` : undefined}
            accessibilityRole={multi ? 'checkbox' : 'radio'}
            accessibilityLabel={`${o.name}${o.priceDeltaCents ? `, +${formatMXN(o.priceDeltaCents)}` : ''}`}
            accessibilityState={{ checked: selected, disabled: !!blocked }}
            onPress={
              blocked
                ? undefined
                : () => {
                    haptic.selection();
                    onChange(toggleModifier(rule, selectedIds, o.id));
                  }
            }
            style={({ pressed }) => [styles.option, selected && styles.optionOn, { opacity: blocked ? 0.5 : pressed ? 0.85 : 1 }]}
          >
            <MaterialCommunityIcons name={icon} size={24} color={selected ? colors.primaryText : colors.textMuted} />
            <AppText variant="body" style={styles.optionName}>
              {o.name}
            </AppText>
            {o.priceDeltaCents !== 0 && (
              <AppText variant="label" color={colors.textSecondary}>
                {`+ ${formatMXN(o.priceDeltaCents)}`}
              </AppText>
            )}
          </Pressable>
        );
      })}
      {!!footer && (
        <AppText variant="caption" color={colors.textMuted}>
          {footer}
        </AppText>
      )}
      {!!error && (
        <AppText variant="label" bold color={colors.dangerText} accessibilityRole="alert">
          {error}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.s2 },
  header: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  title: { flex: 1 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radii.pill },
  option: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingHorizontal: spacing.s3,
    backgroundColor: colors.surfaceRaised,
    borderRadius: radii.md,
    borderWidth: 1.5,
    borderColor: 'transparent',
  },
  optionOn: { borderColor: colors.primary },
  optionName: { flex: 1 },
});
