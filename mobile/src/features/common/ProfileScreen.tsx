import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppButton } from '../../components/AppButton';
import { AppText } from '../../components/AppText';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ConnectionPill } from '../../components/ConnectionPill';
import { LanguageToggle } from '../../components/LanguageToggle';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { SectionHeader } from '../../components/SectionHeader';
import { getServerUrl } from '../../config/serverConfig';
import { useAuthStore } from '../../state/authStore';
import { colors, radii, spacing } from '../../theme/tokens';

function Row({ label, children, testID }: { label: string; children: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.row} testID={testID}>
      <AppText variant="label" color={colors.textSecondary}>
        {label}
      </AppText>
      {typeof children === 'string' ? <AppText variant="body" bold>{children}</AppText> : children}
    </View>
  );
}

/** SCR-X-03 "Yo": shared by all role groups (waiter me, kitchen kds-me, manager profile). */
export function ProfileScreen({ tabs, back }: { tabs?: boolean; back?: boolean }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const onLogout = async () => {
    setBusy(true);
    try {
      await logout();
    } finally {
      setBusy(false);
      setConfirm(false);
      router.replace('/login');
    }
  };

  return (
    <ScreenScaffold
      testID="screen-profile"
      scroll
      edges={tabs ? ['top'] : undefined}
      header={<ScreenHeader title={t('profile.title')} onBack={back ? () => router.back() : undefined} right={<ConnectionPill />} />}
      banner={<OfflineBanner />}
    >
      <View style={styles.card}>
        <Row label={t('profile.user')} testID="profile-name">{user?.name ?? '—'}</Row>
        <Row label={t('profile.role')} testID="profile-role">{user ? t(`roles.${user.role}`, { defaultValue: user.role }) : '—'}</Row>
        <Row label={t('profile.server')} testID="profile-server">{getServerUrl() ?? '—'}</Row>
        <Row label={t('profile.connection')}>
          <ConnectionPill />
        </Row>
      </View>

      <SectionHeader title={t('profile.language')} />
      <LanguageToggle />

      <View style={styles.spacer} />
      <AppButton label={t('logout')} icon="logout" variant="dangerOutline" size="lg" fullWidth onPress={() => setConfirm(true)} testID="logout" />

      <ConfirmDialog
        visible={confirm}
        destructive
        loading={busy}
        title={t('profile.logoutTitle')}
        message={t('profile.logoutMessage')}
        confirmLabel={t('logout')}
        cancelLabel={t('cancel')}
        onConfirm={onLogout}
        onCancel={() => setConfirm(false)}
      />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surfaceRaised, borderRadius: radii.lg, padding: spacing.s4, gap: spacing.s3 },
  row: { gap: spacing.s1 },
  spacer: { flex: 1, minHeight: spacing.s6 },
});
