import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { Animated, useAnimatedValue, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, radii, spacing } from '../theme/tokens';
import { haptic } from '../utils/haptics';
import { useNow } from '../utils/useNow';
import { useReduceMotion } from '../utils/useReduceMotion';
import { AppButton } from './AppButton';
import { AppText } from './AppText';

export const PIN_MIN = 4;
export const PIN_MAX = 6;

export interface PinPadProps {
  /** Auto-submit length, clamped to 4..6. */
  length?: number;
  title?: string;
  message?: string;
  error?: string | null;
  /** The digits are handed over once and cleared locally; they are never stored or logged. */
  onSubmit: (pin: string) => void;
  onCancel?: () => void;
  loading?: boolean;
  /** Epoch ms until which the pad is locked (HTTP 429): shows a countdown. */
  lockedUntil?: number | null;
  testID?: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** Dot-only manager PIN entry (no system keyboard, masked). */
export function PinPad({ length = 4, title, message, error, onSubmit, onCancel, loading, lockedUntil, testID = 'pin-pad' }: PinPadProps) {
  const { t } = useTranslation('mobile');
  const len = Math.min(PIN_MAX, Math.max(PIN_MIN, length));
  const [digits, setDigits] = useState('');
  const now = useNow(undefined, 1000, !!lockedUntil);
  const reduce = useReduceMotion();
  const shake = useAnimatedValue(0);

  const lockLeft = lockedUntil ? Math.max(0, Math.ceil((lockedUntil - now) / 1000)) : 0;
  const locked = lockLeft > 0;
  const busy = !!loading || locked;

  useEffect(() => {
    if (!error) return;
    haptic.error();
    if (reduce) return;
    Animated.sequence([
      Animated.timing(shake, { toValue: 8, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: -8, duration: 50, useNativeDriver: true }),
      Animated.timing(shake, { toValue: 0, duration: 50, useNativeDriver: true }),
    ]).start();
  }, [error, reduce, shake]);

  const submit = (pin: string) => {
    setDigits('');
    onSubmit(pin);
  };
  const press = (d: string) => {
    if (busy || digits.length >= len) return;
    haptic.selection();
    const next = digits + d;
    if (next.length === len) submit(next);
    else setDigits(next);
  };

  const message_ = locked ? t('pin.tooMany') : error ?? message;

  return (
    <View testID={testID} style={styles.wrap}>
      <AppText variant="headline" style={styles.center} accessibilityRole="header">
        {title ?? t('pin.title')}
      </AppText>
      {!!message_ && (
        <AppText
          variant="body"
          color={error || locked ? colors.dangerText : colors.textSecondary}
          style={styles.center}
          accessibilityRole={error || locked ? 'alert' : undefined}
          testID="pin-message"
        >
          {locked ? `${message_} (${lockLeft} s)` : message_}
        </AppText>
      )}
      <Animated.View
        style={[styles.dots, { transform: [{ translateX: shake }] }]}
        accessible
        accessibilityLabel={t('pin.entered', { n: digits.length, len })}
        testID="pin-dots"
      >
        {Array.from({ length: len }, (_, i) => (
          <View key={i} style={[styles.dot, i < digits.length && styles.dotOn]} />
        ))}
      </Animated.View>

      <View style={styles.pad}>
        {KEYS.map((k) => (
          <Key key={k} label={k} a11y={t('pin.digit', { n: k })} disabled={busy} onPress={() => press(k)} testID={`pin-key-${k}`} />
        ))}
        <View style={styles.keySlot} />
        <Key label="0" a11y={t('pin.digit', { n: 0 })} disabled={busy} onPress={() => press('0')} testID="pin-key-0" />
        <Key
          icon="backspace-outline"
          a11y={t('pin.backspace')}
          disabled={busy || digits.length === 0}
          onPress={() => setDigits((d) => d.slice(0, -1))}
          testID="pin-backspace"
        />
      </View>

      <View style={styles.actions}>
        {onCancel && <AppButton label={t('cancel')} variant="secondary" size="lg" onPress={onCancel} disabled={!!loading} testID="pin-cancel" style={styles.act} />}
        <AppButton
          label={t('confirm')}
          size="lg"
          loading={loading}
          disabled={locked || digits.length < PIN_MIN}
          onPress={() => submit(digits)}
          testID="pin-confirm"
          style={styles.act}
        />
      </View>
    </View>
  );
}

function Key({ label, icon, a11y, disabled, onPress, testID }: { label?: string; icon?: 'backspace-outline'; a11y: string; disabled?: boolean; onPress: () => void; testID: string }) {
  return (
    <View style={styles.keySlot}>
      <Pressable
        testID={testID}
        accessibilityRole="button"
        accessibilityLabel={a11y}
        accessibilityState={{ disabled: !!disabled }}
        onPress={disabled ? undefined : onPress}
        style={({ pressed }) => [styles.key, { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 }]}
      >
        {icon ? <MaterialCommunityIcons name={icon} size={26} color={colors.textPrimary} /> : <AppText variant="headline">{label}</AppText>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.s4, alignItems: 'center' },
  center: { textAlign: 'center' },
  dots: { flexDirection: 'row', gap: spacing.s4, paddingVertical: spacing.s2 },
  dot: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: colors.textMuted },
  dotOn: { backgroundColor: colors.primary, borderColor: colors.primary },
  pad: { flexDirection: 'row', flexWrap: 'wrap', width: 3 * (76 + 16), justifyContent: 'center' },
  keySlot: { width: 76, height: 68, alignItems: 'center', justifyContent: 'center', marginHorizontal: 8 },
  key: { width: 68, height: 60, borderRadius: radii.md, backgroundColor: colors.surfaceOverlay, alignItems: 'center', justifyContent: 'center' },
  actions: { flexDirection: 'row', gap: spacing.s2, alignSelf: 'stretch' },
  act: { flex: 1 },
});
