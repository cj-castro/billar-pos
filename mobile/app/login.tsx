import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { loginErrorKey } from '../src/auth/loginErrors';
import { routeForRole } from '../src/auth/roleRouting';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { AppTextField } from '../src/components/AppTextField';
import { LanguageToggle } from '../src/components/LanguageToggle';
import { Logo } from '../src/components/Logo';
import { ScreenScaffold } from '../src/components/ScreenScaffold';
import { getServerUrl } from '../src/config/serverConfig';
import { useAuthStore } from '../src/state/authStore';
import { colors, radii, spacing } from '../src/theme/tokens';
import { haptic } from '../src/utils/haptics';

/** SCR-AUTH-02. */
export default function LoginScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false); // L5: synchronous guard, two taps in one frame must not burn the 10/min login bucket
  const [error, setError] = useState<string | null>(null);
  const host = (getServerUrl() ?? '').replace(/^https?:\/\//, '');

  const onSubmit = async () => {
    if (!username.trim() || !password) {
      setError(t('login.errRequired'));
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError(null);
    try {
      const user = await login(username, password);
      haptic.success();
      router.replace(routeForRole(user.role).href);
    } catch (e) {
      haptic.error();
      setPassword('');
      setError(t(loginErrorKey(e)));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <ScreenScaffold scroll testID="screen-login" footer={<View style={styles.footer}><LanguageToggle /></View>}>
      <View style={styles.head}>
        <Logo size={80} />
        <AppText variant="headline" style={styles.center} accessibilityRole="header">
          {t('login.title')}
        </AppText>
        <View style={styles.pill}>
          <MaterialCommunityIcons name="server" size={20} color={colors.textSecondary} />
          <AppText variant="label" color={colors.textSecondary} numberOfLines={1} style={styles.host}>
            {host}
          </AppText>
          <AppButton label={t('setup.change')} variant="ghost" onPress={() => router.push('/setup')} testID="change-server" disabled={busy} style={styles.change} />
        </View>
      </View>

      {!!error && (
        <View style={styles.error} accessible accessibilityRole="alert" accessibilityLabel={error}>
          <MaterialCommunityIcons name="alert-circle-outline" size={22} color={colors.dangerText} />
          <AppText variant="body" color={colors.dangerText} style={styles.errorText} testID="login-error">
            {error}
          </AppText>
        </View>
      )}
      <AppTextField
        label={t('login.username')}
        icon="account-outline"
        value={username}
        onChangeText={setUsername}
        textContentType="username"
        autoComplete="username"
        returnKeyType="next"
        error={null}
        testID="login-username"
      />
      <AppTextField
        label={t('login.password')}
        icon="lock-outline"
        password
        value={password}
        onChangeText={setPassword}
        textContentType="password"
        autoComplete="password"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        testID="login-password"
      />
      <AppButton label={busy ? t('login.submitting') : t('login.submit')} size="lg" fullWidth loading={busy} onPress={onSubmit} testID="login-submit" />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: spacing.s3, paddingTop: spacing.s4 },
  center: { textAlign: 'center' },
  pill: { flexDirection: 'row', alignItems: 'center', gap: spacing.s2, backgroundColor: colors.surfaceRaised, borderRadius: radii.pill, paddingLeft: spacing.s4, maxWidth: '100%' },
  host: { flexShrink: 1 },
  change: { borderWidth: 0 },
  error: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.s3, backgroundColor: colors.errorBannerBg, borderRadius: radii.md, padding: spacing.s4 },
  errorText: { flex: 1 },
  footer: { padding: spacing.s4, backgroundColor: colors.bg },
});