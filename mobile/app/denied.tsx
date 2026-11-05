import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { routeForRole } from '../src/auth/roleRouting';
import { AppButton } from '../src/components/AppButton';
import { EmptyState } from '../src/components/EmptyState';
import { ScreenHeader } from '../src/components/ScreenHeader';
import { ScreenScaffold } from '../src/components/ScreenScaffold';
import { useAuthStore } from '../src/state/authStore';
import { spacing } from '../src/theme/tokens';

/** SCR-X-01: signed in, but the role cannot use this screen / app. */
export default function DeniedScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const home = user ? routeForRole(user.role).href : '/denied';
  return (
    <ScreenScaffold testID="screen-denied" header={<ScreenHeader title={t('denied.header')} />} padded={false}>
      <EmptyState icon="shield-alert-outline" tone="warning" title={t('denied.title')} message={t('denied.body')} testID="denied" />
      <View style={styles.actions}>
        {home !== '/denied' && <AppButton label={t('denied.goHome')} size="lg" fullWidth onPress={() => router.replace(home)} testID="denied-home" />}
        <AppButton
          label={t('logout')}
          icon="logout"
          variant="dangerOutline"
          size="lg"
          fullWidth
          testID="logout"
          onPress={async () => {
            await logout();
            router.replace('/login');
          }}
        />
      </View>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  actions: { padding: spacing.s6, gap: spacing.s3 },
});