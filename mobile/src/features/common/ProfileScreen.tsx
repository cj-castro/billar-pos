import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, StyleSheet, Switch, View } from 'react-native';
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
import { APP_BUILD, APP_VERSION } from '../../config/version';
import { ensureNotificationPermission, useAlertPrefs } from '../waiter/ready/readyAlerts';
import { useDraftStore } from '../waiter/draft/draftStore';
import { useAuthStore } from '../../state/authStore';
import { colors, radii, spacing } from '../../theme/tokens';
import { UpdateSheet, useUpdater } from '../../update/UpdateUi';

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

function ToggleRow({ label, hint, value, onChange, testID }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void; testID: string }) {
  return (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <AppText variant="body" bold>
          {label}
        </AppText>
        {!!hint && (
          <AppText variant="caption" color={colors.textSecondary}>
            {hint}
          </AppText>
        )}
      </View>
      <Switch testID={testID} accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ true: colors.primary, false: colors.textMuted }} thumbColor={colors.textPrimary} />
    </View>
  );
}

/** SCR-X-03 "Yo": shared by all role groups (waiter me, manager profile). */
export function ProfileScreen({ tabs, back }: { tabs?: boolean; back?: boolean }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [confirm, setConfirm] = useState(false);
  const unsent = useDraftStore((d) => Object.values(d.byTicket).reduce((n, l) => n + l.length, 0)); // M9: logout deletes them
  const [busy, setBusy] = useState(false);
  const upd = useUpdater();
  const prefs = useAlertPrefs();
  const [denied, setDenied] = useState(false);
  // The OS permission is asked the first time alerts are switched on.
  const onAlerts = async (on: boolean) => {
    prefs.setAlerts(on);
    if (on) setDenied(!(await ensureNotificationPermission()));
    else setDenied(false);
  };

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

      {user?.role !== 'KITCHEN_STAFF' && user?.role !== 'BAR_STAFF' && (
        <>
        <SectionHeader title={t('profile.alerts')} />
        <View style={styles.card}>
          <ToggleRow testID="profile-alerts" label={t('profile.alerts')} hint={denied ? t('profile.alertsDenied') : t('profile.alertsHint')} value={prefs.alerts} onChange={onAlerts} />
          <ToggleRow testID="profile-sound" label={t('profile.sound')} hint={t('profile.soundHint')} value={prefs.sound} onChange={prefs.setSound} />
        </View>
        </>
      )}

      {Platform.OS === 'android' && (
        <>
          <SectionHeader title={t('update.check')} />
          <View style={styles.card}>
            {upd.configured ? (
              <AppButton label={t('update.check')} icon="update" variant="secondary" loading={upd.busy === 'check'} onPress={() => void upd.check(true)} testID="profile-check-update" />
            ) : (
              <AppText variant="body" color={colors.textSecondary} testID="profile-update-off">{t('update.notConfigured')}</AppText>
            )}
            {!!upd.msg && !upd.open && <AppText variant="label" color={colors.textSecondary}>{upd.msg}</AppText>}
          </View>
          <UpdateSheet u={upd} />
        </>
      )}

      <View style={styles.spacer} />
      <AppButton label={t('logout')} icon="logout" variant="dangerOutline" size="lg" fullWidth onPress={() => setConfirm(true)} testID="logout" />

      <ConfirmDialog
        visible={confirm}
        destructive
        loading={busy}
        title={t('profile.logoutTitle')}
        message={unsent > 0 ? t('profile.logoutDrafts', { n: unsent }) : t('profile.logoutMessage')}
        confirmLabel={t('logout')}
        cancelLabel={t('cancel')}
        onConfirm={onLogout}
        onCancel={() => setConfirm(false)}
      />
      <AppText variant="caption" color={colors.textMuted} style={styles.version} testID="profile-version">
        {t('profile.version', { v: APP_VERSION, build: APP_BUILD })}
      </AppText>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.surfaceRaised, borderRadius: radii.lg, padding: spacing.s4, gap: spacing.s3 },
  row: { gap: spacing.s1 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  toggleText: { flex: 1 },
  version: { textAlign: 'center', marginTop: spacing.s4 },
  spacer: { flex: 1, minHeight: spacing.s6 },
});
