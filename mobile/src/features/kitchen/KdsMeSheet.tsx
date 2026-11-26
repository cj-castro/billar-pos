import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppButton } from '../../components/AppButton';
import { AppText } from '../../components/AppText';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { LanguageToggle } from '../../components/LanguageToggle';
import type { Station } from '../../domain/types';
import { useAuthStore } from '../../state/authStore';
import { colors, spacing } from '../../theme/tokens';
import { SheetModal } from '../common/SheetModal';
import { StationSwitch } from './StationSwitch';
import { useKdsPrefs } from './kdsPrefs';

export interface KdsMeSheetProps {
  visible: boolean;
  onClose: () => void;
  station: Station;
  /** Provided only for MANAGER/ADMIN (switchable KDS). */
  onStation?: (s: Station) => void;
}

/** KDS "Yo" bottom sheet (long-press on the logo): user, station switch, local mute, language, logout. */
export function KdsMeSheet({ visible, onClose, station, onStation }: KdsMeSheetProps) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const muted = useKdsPrefs((s) => s.muted);
  const setMuted = useKdsPrefs((s) => s.setMuted);
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
    <>
      <SheetModal visible={visible} onClose={onClose} testID="kds-me-sheet">
        <AppText variant="title" bold testID="kds-me-name">
          {user?.name ?? '—'}
        </AppText>
        {onStation && (
          <View style={styles.block}>
            <AppText variant="label" color={colors.textSecondary}>
              {t('kitchen.me.station')}
            </AppText>
            <StationSwitch value={station} onChange={onStation} />
          </View>
        )}
        <View style={styles.toggle}>
          <View style={styles.toggleText}>
            <AppText variant="body" bold>
              {t('kitchen.me.mute')}
            </AppText>
            <AppText variant="caption" color={colors.textSecondary}>
              {t('kitchen.me.muteHint')}
            </AppText>
          </View>
          <Switch testID="kds-me-mute" accessibilityLabel={t('kitchen.me.mute')} value={muted} onValueChange={setMuted} trackColor={{ true: colors.primary, false: colors.textMuted }} thumbColor={colors.textPrimary} />
        </View>
        <View style={styles.block}>
          <AppText variant="label" color={colors.textSecondary}>
            {t('profile.language')}
          </AppText>
          <LanguageToggle />
        </View>
        <AppButton
          label={t('logout')}
          icon="logout"
          variant="dangerOutline"
          size="lg"
          fullWidth
          testID="kds-me-logout"
          onPress={() => {
            onClose();
            setConfirm(true);
          }}
        />
      </SheetModal>
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
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: spacing.s2, alignItems: 'flex-start' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.s3 },
  toggleText: { flex: 1 },
});
