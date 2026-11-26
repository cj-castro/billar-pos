import { useEffect } from 'react';
import { Animated, useAnimatedValue, StyleSheet, View } from 'react-native';
import { colors, radii, spacing } from '../theme/tokens';
import { useReduceMotion } from '../utils/useReduceMotion';

export type SkeletonVariant = 'floor' | 'ticket' | 'menu' | 'kds' | 'list' | 'stats';

const DEFAULT_COUNT: Record<SkeletonVariant, number> = { floor: 6, ticket: 4, menu: 8, kds: 2, list: 5, stats: 4 };
const HEIGHT: Record<SkeletonVariant, number> = { floor: 68, ticket: 64, menu: 92, kds: 180, list: 72, stats: 96 };
const COLUMNS: Record<SkeletonVariant, number> = { floor: 3, ticket: 1, menu: 2, kds: 1, list: 1, stats: 2 };

/** Shimmer placeholders (static under reduced motion). Only for first load without cache. */
export function LoadingSkeleton({ variant, count, testID = 'loading-skeleton' }: { variant: SkeletonVariant; count?: number; testID?: string }) {
  const reduce = useReduceMotion();
  const opacity = useAnimatedValue(0.6);
  useEffect(() => {
    if (reduce) {
      opacity.setValue(0.6);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 600, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reduce, opacity]);

  const n = count ?? DEFAULT_COUNT[variant];
  const cols = COLUMNS[variant];
  return (
    <View testID={testID} accessible accessibilityRole="progressbar" accessibilityLabel="Cargando" style={styles.grid}>
      {Array.from({ length: n }, (_, i) => (
        <Animated.View
          key={i}
          style={[styles.block, { opacity, height: HEIGHT[variant], width: cols === 1 ? '100%' : cols === 2 ? '48.5%' : '31.5%' }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: spacing.s2, padding: spacing.s4 },
  block: { backgroundColor: colors.surfaceRaised, borderRadius: radii.md },
});
