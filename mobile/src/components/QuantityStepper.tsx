import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, radii, spacing, touch } from '../theme/tokens';
import { haptic } from '../utils/haptics';
import { AppText } from './AppText';

export interface QuantityStepperProps {
  value: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
  /** lg = 56 dp buttons, sm = 48 dp. */
  size?: 'lg' | 'sm';
  testID?: string;
}

const REPEAT_MS = 200; // 5 Hz

function StepButton({
  delta,
  dim,
  atBound,
  label,
  onStep,
  testID,
}: {
  delta: 1 | -1;
  dim: number;
  atBound: boolean;
  label: string;
  /** Returns false when the step hit a bound (stops auto-repeat). */
  onStep: (delta: 1 | -1) => boolean;
  testID?: string;
}) {
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: atBound }}
      onPress={atBound ? undefined : () => onStep(delta)}
      onLongPress={
        atBound
          ? undefined
          : () => {
              stop();
              timer.current = setInterval(() => {
                if (!onStep(delta)) stop();
              }, REPEAT_MS);
            }
      }
      onPressOut={stop}
      style={({ pressed }) => [styles.btn, { width: dim, height: dim, opacity: atBound ? 0.4 : pressed ? 0.8 : 1 }]}
    >
      <MaterialCommunityIcons name={delta === 1 ? 'plus' : 'minus'} size={26} color={colors.textPrimary} />
    </Pressable>
  );
}

export function QuantityStepper({ value, min = 1, max = 99, onChange, size = 'lg', testID }: QuantityStepperProps) {
  const { t } = useTranslation('mobile');
  const dim = size === 'lg' ? touch.primary : touch.min;
  // Latest value for the auto-repeat interval (state would be stale inside it).
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);

  const step = (delta: 1 | -1): boolean => {
    const next = Math.min(max, Math.max(min, latest.current + delta));
    if (next === latest.current) return false;
    latest.current = next;
    haptic.selection();
    onChange(next);
    return true;
  };

  return (
    <View
      testID={testID}
      style={styles.row}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={t('stepper.value')}
      accessibilityValue={{ min, max, now: value, text: String(value) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
    >
      <StepButton delta={-1} dim={dim} atBound={value <= min} label={t('stepper.decrease')} onStep={step} testID={testID ? `${testID}-dec` : undefined} />
      <AppText variant="title" style={styles.value} accessibilityElementsHidden>
        {value}
      </AppText>
      <StepButton delta={1} dim={dim} atBound={value >= max} label={t('stepper.increase')} onStep={step} testID={testID ? `${testID}-inc` : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2 },
  btn: { borderRadius: radii.md, backgroundColor: colors.surfaceOverlay, alignItems: 'center', justifyContent: 'center' },
  value: { minWidth: 44, textAlign: 'center', fontVariant: ['tabular-nums'] },
});
