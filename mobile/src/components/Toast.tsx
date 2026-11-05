import { MaterialCommunityIcons } from '@expo/vector-icons';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, useAnimatedValue, Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors, elevation, layout, radii, spacing, type IconName } from '../theme/tokens';
import { useReduceMotion } from '../utils/useReduceMotion';
import { AppText } from './AppText';

export type ToastTone = 'success' | 'info' | 'error' | 'warning';

export interface ToastOptions {
  tone?: ToastTone;
  title: string;
  message?: string;
  action?: { label: string; onPress: () => void };
  /** Default 4000, 6000 with an action. */
  durationMs?: number;
}

interface ToastApi {
  show: (t: ToastOptions) => void;
  dismiss: () => void;
}

const NOOP: ToastApi = { show: () => {}, dismiss: () => {} };
const Ctx = createContext<ToastApi>(NOOP);

/** Imperative toast API. Safe (no-op) outside a ToastProvider. */
export function useToast(): ToastApi {
  return useContext(Ctx);
}

const TONE: Record<ToastTone, { bg: string; fg: string; icon: IconName }> = {
  success: { bg: colors.successTint, fg: colors.success, icon: 'check-circle-outline' },
  info: { bg: colors.infoTint, fg: colors.info, icon: 'information-outline' },
  warning: { bg: colors.warningTint, fg: colors.warning, icon: 'alert-outline' },
  error: { bg: colors.dangerTint, fg: colors.dangerText, icon: 'alert-circle-outline' },
};

/** One toast visible at a time; a new one replaces the current (coalesce wording in the caller). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('mobile');
  const insets = useSafeAreaInsets();
  const reduce = useReduceMotion();
  const [current, setCurrent] = useState<(ToastOptions & { id: number }) | null>(null);
  const anim = useAnimatedValue(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const dismiss = useCallback(() => {
    clear();
    Animated.timing(anim, { toValue: 0, duration: reduce ? 0 : 200, useNativeDriver: true }).start(() => setCurrent(null));
  }, [anim, clear, reduce]);

  const show = useCallback(
    (opts: ToastOptions) => {
      clear();
      setCurrent({ ...opts, id: ++seq.current });
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: reduce ? 0 : 200, useNativeDriver: true }).start();
      timer.current = setTimeout(dismiss, opts.durationMs ?? (opts.action ? 6000 : 4000));
    },
    [anim, clear, dismiss, reduce],
  );

  useEffect(() => clear, [clear]);
  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const tone = TONE[current?.tone ?? 'info'];

  return (
    <Ctx.Provider value={api}>
      {children}
      {current && (
        <Animated.View
          pointerEvents="box-none"
          style={[
            styles.host,
            { top: insets.top + layout.topBarHeight, opacity: anim, transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-16, 0] }) }] },
          ]}
        >
          <View
            testID="toast"
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            accessible
            accessibilityLabel={[current.title, current.message].filter(Boolean).join('. ')}
            style={[styles.toast, { backgroundColor: tone.bg, borderColor: tone.fg }]}
          >
            <MaterialCommunityIcons name={tone.icon} size={24} color={tone.fg} />
            <View style={styles.body}>
              <AppText variant="body" bold color={colors.textPrimary}>
                {current.title}
              </AppText>
              {!!current.message && (
                <AppText variant="label" color={colors.textSecondary}>
                  {current.message}
                </AppText>
              )}
            </View>
            {current.action && (
              <Pressable
                testID="toast-action"
                accessibilityRole="button"
                accessibilityLabel={current.action.label}
                hitSlop={8}
                style={styles.action}
                onPress={() => {
                  current.action?.onPress();
                  dismiss();
                }}
              >
                <AppText variant="body" bold color={tone.fg}>
                  {current.action.label}
                </AppText>
              </Pressable>
            )}
            <Pressable testID="toast-dismiss" accessibilityRole="button" accessibilityLabel={t('toast.dismiss')} hitSlop={8} onPress={dismiss} style={styles.action}>
              <MaterialCommunityIcons name="close" size={22} color={colors.textSecondary} />
            </Pressable>
          </View>
        </Animated.View>
      )}
    </Ctx.Provider>
  );
}

const styles = StyleSheet.create({
  host: { position: 'absolute', left: spacing.s4, right: spacing.s4 },
  toast: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.s3,
    paddingHorizontal: spacing.s3,
    paddingVertical: spacing.s2,
    borderRadius: radii.md,
    borderWidth: 1,
    elevation: elevation.e2,
  },
  body: { flex: 1 },
  action: { minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
