import { useRouter } from 'expo-router';
import { Linking, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { boot } from '../src/auth/boot';
import { AppButton } from '../src/components/AppButton';
import { AppText } from '../src/components/AppText';
import { EmptyState } from '../src/components/EmptyState';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { ScreenScaffold } from '../src/components/ScreenScaffold';
import { getServerUrl } from '../src/config/serverConfig';
import { getServerInfo } from '../src/config/serverInfo';
import { APP_VERSION } from '../src/config/version';
import { colors, spacing } from '../src/theme/tokens';
import { UpdateSheet, useUpdater } from '../src/update/UpdateUi';

/** Full-screen block: the server's `min_mobile_version` is newer than this app. */
export default function UpdateRequiredScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const info = getServerInfo();
  const base = getServerUrl();
  const upd = useUpdater();
  return (
    <ScreenScaffold testID="screen-update-required" header={<ScreenHeader title={t('update.title')} />} padded={false}>
      <EmptyState icon="update" tone="warning" title={t('update.title')} message={t('update.body')} testID="update-required" />
      <View style={styles.info}>
        {!!info.server_version && <AppText variant="label" color={colors.textSecondary}>{t('update.serverVersion', { v: info.server_version })}</AppText>}
        {!!info.min_mobile_version && <AppText variant="label" color={colors.textSecondary}>{t('update.minVersion', { v: info.min_mobile_version })}</AppText>}
        <AppText variant="label" color={colors.textSecondary}>{t('update.appVersion', { v: APP_VERSION })}</AppText>
      </View>
      <View style={styles.actions}>
        {upd.configured && <AppButton label={t('update.download')} icon="download" size="lg" fullWidth loading={upd.busy === 'check'} onPress={() => void upd.check(true)} testID="update-self" />}
        {!!upd.msg && !upd.open && <AppText variant="label" color={colors.textSecondary}>{upd.msg}</AppText>}
        {!!base && <AppButton label={t('update.open')} icon="download" size="lg" fullWidth onPress={() => void Linking.openURL(`${base}/mobile/latest.apk`)} testID="update-open" />}
        <AppButton label={t('retry')} variant="secondary" size="lg" fullWidth onPress={async () => router.replace(await boot())} testID="update-retry" />
      </View>
      <UpdateSheet u={upd} />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  info: { paddingHorizontal: spacing.s6, gap: spacing.s1, alignItems: 'center' },
  actions: { padding: spacing.s6, gap: spacing.s3 },
});
