import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppButton } from '../../components/AppButton';
import { AppText } from '../../components/AppText';
import { AppTextField } from '../../components/AppTextField';
import { useToast } from '../../components/Toast';
import { colors, spacing } from '../../theme/tokens';
import { errorMessage } from '../../utils/errorMessage';
import { haptic } from '../../utils/haptics';
import { useTextSetting } from './useDiagnostics';

/** Text/number setting with its own Save button. `numeric` validates a positive integer. */
function SettingField({ settingKey, label, numeric, placeholder }: { settingKey: string; label: string; numeric?: boolean; placeholder?: string }) {
  const { t } = useTranslation('mobile');
  const toast = useToast();
  const s = useTextSetting(settingKey);
  const [edit, setText] = useState<string | null>(null); // null = untouched, show the server value
  const text = edit ?? s.value ?? '';
  const [error, setError] = useState<string | null>(null);
  const save = () => {
    const v = text.trim();
    if (numeric && !/^\d+$/.test(v)) return setError(t('reports.system.invalidNumber'));
    setError(null);
    s.mutation.mutate(v, {
      onSuccess: () => {
        setText(null);
        haptic.success();
        toast.show({ tone: 'success', title: t('reports.system.saved') });
      },
      onError: (e) => {
        haptic.error();
        toast.show({ tone: 'error', title: t('admin.saveFailed'), message: errorMessage(e) });
      },
    });
  };
  return (
    <View style={styles.gap} testID={`setting-${settingKey}`}>
      <AppTextField
        label={label}
        placeholder={placeholder}
        value={text}
        onChangeText={setText}
        keyboardType={numeric ? 'number-pad' : 'default'}
        error={error ?? (s.query.isError ? errorMessage(s.query.error) : null)}
        editable={s.value !== null}
        testID={`input-${settingKey}`}
      />
      <AppButton label={t('reports.system.save')} variant="secondary" loading={s.mutation.isPending} disabled={s.value === null || text.trim() === s.value} onPress={save} testID={`save-${settingKey}`} />
    </View>
  );
}

/** waiter_can_close_ticket: unset ('') means true on the server (default). */
function WaiterCloseToggle() {
  const { t } = useTranslation('mobile');
  const toast = useToast();
  const s = useTextSetting('waiter_can_close_ticket');
  const on = s.value === null ? false : s.value !== 'false' && s.value !== '0';
  return (
    <View style={styles.toggle} testID="setting-waiter_can_close_ticket">
      <View style={styles.flex}>
        <AppText variant="body" bold>
          {t('reports.system.waiterClose')}
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {t('reports.system.waiterCloseHint')}
        </AppText>
      </View>
      <Switch
        testID="switch-waiter_can_close_ticket"
        accessibilityLabel={t('reports.system.waiterClose')}
        value={on}
        disabled={s.value === null || s.mutation.isPending}
        onValueChange={(next) =>
          s.mutation.mutate(next ? 'true' : 'false', {
            onSuccess: () => haptic.success(),
            onError: (e) => toast.show({ tone: 'error', title: t('admin.saveFailed'), message: errorMessage(e) }),
          })
        }
        trackColor={{ true: colors.primary, false: colors.surfaceOverlay }}
        thumbColor={colors.textPrimary}
      />
    </View>
  );
}

export function SystemEditors() {
  const { t } = useTranslation('mobile');
  return (
    <>
      <SettingField settingKey="kds_warn_min" numeric label={t('reports.system.kdsWarn')} />
      <SettingField settingKey="kds_late_min" numeric label={t('reports.system.kdsLate')} />
      <WaiterCloseToggle />
      <SettingField settingKey="min_mobile_version" placeholder="1.0.0" label={t('reports.system.minMobileSetting')} />
    </>
  );
}

const styles = StyleSheet.create({
  gap: { gap: spacing.s2 },
  flex: { flex: 1 },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3, minHeight: 56 },
});
