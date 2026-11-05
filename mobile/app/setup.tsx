import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { TextField } from '../src/components/TextField';
import { getServerUrl, saveServerUrl, validateServer } from '../src/config/serverConfig';
import { colors, font } from '../src/theme/tokens';

const ERR_KEY = {
  invalid: 'setup.errInvalid',
  timeout: 'setup.errTimeout',
  unreachable: 'setup.errUnreachable',
  not_pos: 'setup.errNotPos',
} as const;

export default function SetupScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const [value, setValue] = useState(getServerUrl() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onConnect = async () => {
    setBusy(true);
    setError(null);
    const check = await validateServer(value);
    if (!check.ok) {
      setError(t(ERR_KEY[check.reason]));
      setBusy(false);
      return;
    }
    await saveServerUrl(value);
    setBusy(false);
    router.replace('/login');
  };

  return (
    <Screen>
      <Text style={styles.title}>{t('setup.title')}</Text>
      <Text style={styles.muted}>{t('setup.subtitle')}</Text>
      <TextField
        label={t('setup.label')}
        placeholder={t('setup.placeholder')}
        value={value}
        onChangeText={setValue}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={onConnect}
        error={error}
        testID="server-input"
      />
      <Text style={styles.hint}>{t('setup.hint')}</Text>
      <Button
        title={busy ? t('setup.checking') : t('setup.connect')}
        onPress={onConnect}
        loading={busy}
        disabled={!value.trim()}
        testID="server-connect"
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.xl, fontWeight: '700' },
  muted: { color: colors.textMuted, fontSize: font.md },
  hint: { color: colors.textMuted, fontSize: font.sm },
});
