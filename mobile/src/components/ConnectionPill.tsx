import { useEffect } from 'react';
import { Animated, useAnimatedValue, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, connColor, radii, type ConnLevel } from '../theme/tokens';
import { useReduceMotion } from '../utils/useReduceMotion';
import { AppText } from './AppText';
import { useConnectionLevel } from './connection';

const KEY: Record<ConnLevel, string> = { online: 'connected', reconnecting: 'reconnecting', offline: 'disconnected' };

export interface ConnectionPillProps {
  /** Override the derived state (stories / tests). */
  state?: ConnLevel;
  /** Dot only. */
  compact?: boolean;
  testID?: string;
}

export function ConnectionPill({ state, compact, testID = 'connection-pill' }: ConnectionPillProps) {
  const { t } = useTranslation('mobile');
  const derived = useConnectionLevel();
  const level = state ?? derived;
  const label = t(`connection.${KEY[level]}`);
  const reduce = useReduceMotion();
  const pulse = useAnimatedValue(1);

  useEffect(() => {
    if (level !== 'reconnecting' || reduce) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.3, duration: 500, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [level, reduce, pulse]);

  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      style={styles.pill}
    >
      <Animated.View style={[styles.dot, { backgroundColor: connColor[level], opacity: pulse }]} />
      {!compact && (
        <AppText variant="caption" bold color={colors.textSecondary}>
          {label}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.pill,
    backgroundColor: colors.surfaceRaised,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
