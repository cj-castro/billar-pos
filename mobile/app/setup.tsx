import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { AppTextField } from '../src/components/AppTextField';
import { LanguageToggle } from '../src/components/LanguageToggle';
import { Logo } from '../src/components/Logo';
import { ScreenScaffold } from '../src/components/ScreenScaffold';
import { ConfirmDialog } from '../src/components/ConfirmDialog';
import { updateRequired } from '../src/config/serverInfo';
import { getServerUrl, normalizeServerUrl, saveServerUrl, validateServer } from '../src/config/serverConfig';
import { useAuthStore } from '../src/state/authStore';
import { colors, radii, spacing } from '../src/theme/tokens';
import { haptic } from '../src/utils/haptics';

const ERR_KEY = {
  invalid: 'setup.errInvalid',
  insecure: 'setup.errInsecure',
  timeout: 'setup.errTimeout',
  unreachable: 'setup.errUnreachable',
  not_pos: 'setup.errNotPos',
} as const;

/** SCR-AUTH-01: enter the POS address, test it, continue to login. */
export default function SetupScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const [value, setValue] = useState(getServerUrl() ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMs, setOkMs] = useState<number | null>(null);
  const hasSession = useAuthStore((st) => !!st.user);
  const [confirmSwitch, setConfirmSwitch] = useState(false);

  const onTest = async () => {
    setBusy(true);
    setError(null);
    setOkMs(null);
    const started = Date.now();
    const check = await validateServer(value);
    setBusy(false);
    if (!check.ok) {
      haptic.error();
      setError(t(ERR_KEY[check.reason]));
      return;
    }
    haptic.success();
    setOkMs(Date.now() - started);
  };

  const commit = async () => {
    // SEC-02: credentials belong to the host that issued them. A different host ends the session first
    // (tokens, user, query cache, socket, drafts) so nothing is ever sent to the new host.
    if (hasSession && normalizeServerUrl(value) !== getServerUrl()) await useAuthStore.getState().logout();
    await saveServerUrl(value);
    router.replace(updateRequired() ? '/update-required' : '/login');
  };
  const onContinue = () => {
    if (hasSession && normalizeServerUrl(value) !== getServerUrl()) setConfirmSwitch(true);
    else void commit();
  };

  return (
    <ScreenScaffold
      scroll
      testID="screen-setup"
      footer={
        <View style={styles.footer}>
          <AppButton label={t('continue')} size="lg" fullWidth disabled={okMs === null} onPress={onContinue} testID="server-continue" />
          <LanguageToggle />
        </View>
      }
    >
      <View style={styles.head}>
        <Logo />
        <AppText variant="headline" style={styles.center} accessibilityRole="header">
          {t('setup.title')}
        </AppText>
        <AppText variant="body" color={colors.textSecondary} style={styles.center}>
          {t('setup.subtitle')}
        </AppText>
      </View>
      <AppTextField
        label={t('setup.label')}
        icon="server"
        placeholder={t('setup.placeholder')}
        value={value}
        onChangeText={(v) => {
          setValue(v);
          setOkMs(null);
          setError(null);
        }}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={onTest}
        error={error}
        testID="server-input"
      />
      <AppButton
        label={busy ? t('setup.checking') : t('setup.connect')}
        icon="refresh"
        variant="secondary"
        size="lg"
        fullWidth
        loading={busy}
        disabled={!value.trim()}
        onPress={onTest}
        testID="server-connect"
      />
      {okMs !== null && (
        <View style={styles.ok} accessibilityRole="alert" accessible accessibilityLabel={`${t('setup.ok')}. ${t('setup.okBody')}`} testID="server-ok">
          <MaterialCommunityIcons name="check" size={24} color={colors.success} />
          <View>
            <AppText variant="body" bold color={colors.success}>
              {t('setup.ok')}
            </AppText>
            <AppText variant="label" color={colors.textSecondary}>
              {`${t('setup.okBody')} ${okMs} ms`}
            </AppText>
          </View>
        </View>
      )}
      <ConfirmDialog
        visible={confirmSwitch}
        title={t('setup.switchTitle')}
        message={t('setup.switchBody')}
        confirmLabel={t('setup.switchConfirm')}
        cancelLabel={t('cancel')}
        destructive
        onCancel={() => setConfirmSwitch(false)}
        onConfirm={() => {
          setConfirmSwitch(false);
          void commit();
        }}
        testID="switch-server-dialog"
      />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  head: { alignItems: 'center', gap: spacing.s3, paddingTop: spacing.s6 },
  center: { textAlign: 'center' },
  ok: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, backgroundColor: colors.successTint, borderRadius: radii.md, padding: spacing.s4 },
  footer: { padding: spacing.s4, gap: spacing.s3, backgroundColor: colors.bg },
});