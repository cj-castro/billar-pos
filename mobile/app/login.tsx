import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { loginErrorKey } from '../src/auth/loginErrors';
import { routeForRole } from '../src/auth/roleRouting';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { TextField } from '../src/components/TextField';
import { getServerUrl } from '../src/config/serverConfig';
import { useAuthStore } from '../src/state/authStore';
import { colors, font } from '../src/theme/tokens';

export default function LoginScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async () => {
    if (!username.trim() || !password) {
      setError(t('login.errRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const user = await login(username, password);
      router.replace(routeForRole(user.role).href);
    } catch (e) {
      setError(t(loginErrorKey(e)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Text style={styles.title}>{t('login.title')}</Text>
      <TextField
        label={t('login.username')}
        value={username}
        onChangeText={setUsername}
        textContentType="username"
        autoComplete="username"
        returnKeyType="next"
        testID="login-username"
      />
      <TextField
        label={t('login.password')}
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="password"
        autoComplete="password"
        returnKeyType="go"
        onSubmitEditing={onSubmit}
        testID="login-password"
      />
      {!!error && (
        <Text style={styles.error} accessibilityRole="alert" testID="login-error">
          {error}
        </Text>
      )}
      <Button title={busy ? t('login.submitting') : t('login.submit')} onPress={onSubmit} loading={busy} testID="login-submit" />
      <Text style={styles.muted}>
        {t('login.server')}: {getServerUrl()}
      </Text>
      <Button title={t('setup.change')} variant="secondary" onPress={() => router.push('/setup')} testID="change-server" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.xl, fontWeight: '700' },
  error: { color: colors.danger, fontSize: font.md },
  muted: { color: colors.textMuted, fontSize: font.sm },
});
