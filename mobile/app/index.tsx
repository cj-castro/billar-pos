import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Animated, useAnimatedValue, Easing, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { boot, type BootTarget } from '../src/auth/boot';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { Logo } from '../src/components/Logo';
import { ScreenScaffold } from '../src/components/ScreenScaffold';
import { colors, radii, spacing } from '../src/theme/tokens';

const SLOW_MS = 3000;

function ProgressBar() {
  const x = useAnimatedValue(0);
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(x, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [x]);
  return (
    <View style={styles.track} accessibilityRole="progressbar">
      <Animated.View
        style={[styles.fill, { transform: [{ translateX: x.interpolate({ inputRange: [0, 1], outputRange: [-60, 160] }) }] }]}
      />
    </View>
  );
}

/** SCR-AUTH-00: boot gate. Decides setup / login / role home, then redirects. */
export default function Index() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const [target, setTarget] = useState<BootTarget | null>(null);
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const id = setTimeout(() => setSlow(true), SLOW_MS);
    boot()
      .then(setTarget)
      .catch(() => setTarget('/setup'))
      .finally(() => clearTimeout(id));
    return () => clearTimeout(id);
  }, [attempt]);
  const retry = useCallback(() => {
    setSlow(false);
    setAttempt((a) => a + 1);
  }, []);

  if (target) return <Redirect href={target} />;
  return (
    <ScreenScaffold scroll center testID="screen-splash">
      <View style={styles.center}>
        <Logo size={96} />
        <AppText variant="headline" style={styles.title}>
          Bola 8 Pool Club
        </AppText>
        <AppText variant="body" color={colors.textSecondary}>
          {t('splash.restoring')}
        </AppText>
        <ProgressBar />
        {slow && (
          <View style={styles.slow}>
            <AppButton label={t('retry')} variant="secondary" onPress={retry} testID="splash-retry" />
            <AppButton label={t('setup.change')} variant="ghost" onPress={() => router.replace('/setup')} testID="splash-change-server" />
          </View>
        )}
      </View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', gap: spacing.s3 },
  title: { marginTop: spacing.s3 },
  track: { width: 160, height: 4, borderRadius: radii.pill, backgroundColor: colors.surfaceRaised, overflow: 'hidden', marginTop: spacing.s2 },
  fill: { width: 60, height: 4, borderRadius: radii.pill, backgroundColor: colors.primary },
  slow: { flexDirection: 'row', gap: spacing.s2, marginTop: spacing.s4 },
});