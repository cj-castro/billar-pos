import { Redirect } from 'expo-router';
import { useState, type ReactNode } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppButton } from '../../components/AppButton';
import { AppText } from '../../components/AppText';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ConnectionPill } from '../../components/ConnectionPill';
import { OfflineBanner } from '../../components/OfflineBanner';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { SectionHeader } from '../../components/SectionHeader';
import { useToast } from '../../components/Toast';
import { useLastUpdated } from '../../components/connection';
import { getServerUrl } from '../../config/serverConfig';
import { getServerInfo } from '../../config/serverInfo';
import { APP_BUILD, APP_VERSION } from '../../config/version';
import { socketTransport, useConnectionStore } from '../../realtime/socket';
import { useAuthStore } from '../../state/authStore';
import { colors, radii, spacing } from '../../theme/tokens';
import { errorMessage } from '../../utils/errorMessage';
import { haptic } from '../../utils/haptics';
import { formatClock } from '../../utils/time';
import { SystemEditors } from './SystemEditors';
import { useHealthProbe, useServerSetting, type SettingKey } from './useDiagnostics';

function Row({ label, value, testID, tone }: { label: string; value: ReactNode; testID?: string; tone?: 'ok' | 'bad' }) {
  return (
    <View style={styles.row} testID={testID}>
      <AppText variant="label" color={colors.textSecondary}>
        {label}
      </AppText>
      {typeof value === 'string' ? (
        <AppText variant="body" bold color={tone === 'ok' ? colors.success : tone === 'bad' ? colors.dangerText : colors.textPrimary}>
          {value}
        </AppText>
      ) : (
        value
      )}
    </View>
  );
}

function SettingToggle({ settingKey, label, hint, s, onToggle }: { settingKey: SettingKey; label: string; hint: string; s: ReturnType<typeof useServerSetting>; onToggle: (key: SettingKey, label: string, next: boolean) => void }) {
  const { t } = useTranslation('mobile');
  const loading = s.value === null;
  return (
    <View style={styles.toggleRow} testID={`setting-${settingKey}`}>
      <View style={styles.flex}>
        <AppText variant="body" bold>
          {label}
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {s.query.isError ? errorMessage(s.query.error) : hint}
        </AppText>
      </View>
      <Switch
        testID={`switch-${settingKey}`}
        accessibilityLabel={`${label}: ${s.value ? t('admin.on') : t('admin.off')}`}
        value={!!s.value}
        disabled={loading || s.mutation.isPending}
        onValueChange={(next) => onToggle(settingKey, label, next)}
        trackColor={{ true: colors.primary, false: colors.surfaceOverlay }}
        thumbColor={colors.textPrimary}
      />
    </View>
  );
}

/** SCR-A-01 diagnostics + server settings. ADMIN only (tab hidden by role; a deep link to /system is redirected). */
export function SystemScreen() {
  const role = useAuthStore((s) => s.user?.role);
  if (role !== 'ADMIN') return <Redirect href="/denied" />;
  return <SystemContent />;
}

function SystemContent() {
  const { t } = useTranslation('mobile');
  const toast = useToast();
  const user = useAuthStore((s) => s.user);
  const conn = useConnectionStore((s) => s.state);
  const lastSync = useLastUpdated();
  const { state: h, probe } = useHealthProbe();
  const [pending, setPending] = useState<{ key: SettingKey; label: string; next: boolean } | null>(null);
  const kds = useServerSetting('kds_sound_enabled');
  const bar = useServerSetting('print_bar_tickets');
  const mutations = { kds_sound_enabled: kds.mutation, print_bar_tickets: bar.mutation };
  const active = pending ? mutations[pending.key] : null;

  const version = APP_VERSION;
  const build = String(APP_BUILD);
  const transport = socketTransport() ?? t('admin.transportNone');

  const healthText =
    h.status === 'testing' ? t('admin.healthTesting') : h.status === 'ok' ? t('admin.healthOk', { ms: h.ms }) : h.status === 'fail' ? t('admin.healthFail') : t('admin.healthNever');

  const confirm = () => {
    if (!pending) return;
    const { key, next } = pending;
    mutations[key].mutate(next, {
      onSuccess: () => {
        haptic.success();
        toast.show({ tone: 'success', title: t('admin.saved') });
        setPending(null);
      },
      onError: (e) => {
        haptic.error();
        toast.show({ tone: 'error', title: t('admin.saveFailed'), message: errorMessage(e) });
        setPending(null);
      },
    });
  };

  return (
    <ScreenScaffold testID="screen-system" scroll edges={['top']} header={<ScreenHeader title={t('admin.title')} right={<ConnectionPill />} />} banner={<OfflineBanner />}>
      <SectionHeader title={t('admin.connection')} />
      <View style={styles.card}>
        <Row label={t('admin.server')} value={getServerUrl() ?? '—'} testID="diag-server" />
        <Row label={t('admin.health')} value={healthText} testID="diag-health" tone={h.status === 'ok' ? 'ok' : h.status === 'fail' ? 'bad' : undefined} />
        {h.status === 'fail' && h.lastOkAt != null && (
          <AppText variant="caption" color={colors.textMuted} testID="diag-last-ok">
            {t('admin.lastOk', { time: formatClock(h.lastOkAt) })}
          </AppText>
        )}
        <Row label={t('admin.socket')} value={`${t(`admin.state.${conn}`)} · ${transport}`} testID="diag-socket" />
        <Row label={t('admin.lastSync')} value={lastSync ? formatClock(lastSync) : '—'} testID="diag-sync" />
        <AppButton
          label={t('admin.test')}
          icon="lan-connect"
          variant="secondary"
          fullWidth
          loading={h.status === 'testing'}
          onPress={() => {
            probe().then(() => haptic.selection());
          }}
          testID="diag-test"
        />
      </View>

      <SectionHeader title={t('admin.account')} />
      <View style={styles.card}>
        <Row label={t('admin.version')} value={`${version} (${build})`} testID="diag-version" />
        <Row label={t('reports.system.serverVersion')} value={getServerInfo().server_version ?? '—'} testID="diag-server-version" />
        <Row label={t('reports.system.minMobile')} value={getServerInfo().min_mobile_version ?? '—'} testID="diag-min-version" />
        <Row label={t('admin.user')} value={user ? `${user.name} · ${t(`roles.${user.role}`, { defaultValue: user.role })}` : '—'} testID="diag-user" />
      </View>

      <SectionHeader title={t('admin.settings')} />
      <View style={styles.card}>
        <SettingToggle settingKey="kds_sound_enabled" s={kds} label={t('admin.kdsSound')} hint={t('admin.kdsSoundHint')} onToggle={(key, label, next) => setPending({ key, label, next })} />
        <SettingToggle settingKey="print_bar_tickets" s={bar} label={t('admin.printBar')} hint={t('admin.printBarHint')} onToggle={(key, label, next) => setPending({ key, label, next })} />
      </View>

      <SectionHeader title={t('reports.system.editors')} />
      <View style={styles.card}>
        <SystemEditors />
      </View>

      <ConfirmDialog
        visible={pending !== null}
        title={t('admin.confirmTitle')}
        message={pending ? t('admin.confirmMessage', { label: pending.label, value: pending.next ? t('admin.on') : t('admin.off') }) : undefined}
        confirmLabel={t('confirm')}
        cancelLabel={t('cancel')}
        loading={!!active?.isPending}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { backgroundColor: colors.surfaceRaised, borderRadius: radii.lg, padding: spacing.s4, gap: spacing.s3 },
  row: { gap: 2 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 56 },
});
