import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppButton } from '../components/AppButton';
import { AppText } from '../components/AppText';
import { SheetModal } from '../features/common/SheetModal';
import { colors, radii } from '../theme/tokens';
import { checkForUpdate, downloadAndInstall, updatesConfigured, type FoundUpdate } from './updater';

/** Local state only (no store): one instance per surface (auto-check, Profile row, update-required screen). */
export function useUpdater() {
  const { t } = useTranslation('mobile');
  const [found, setFound] = useState<FoundUpdate | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'check' | 'download' | null>(null);
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState('');

  const check = useCallback(
    async (force: boolean) => {
      setBusy('check');
      setMsg('');
      try {
        const f = await checkForUpdate(force);
        if (f) {
          setFound(f);
          setOpen(true);
        } else if (force) setMsg(t('update.upToDate'));
      } catch {
        if (force) setMsg(t('update.checkFailed')); // the silent start-up check just retries next start
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const install = async () => {
    if (!found) return;
    setBusy('download');
    setPct(0);
    setMsg('');
    try {
      await downloadAndInstall(found, setPct);
      setOpen(false);
    } catch {
      setMsg(t('update.failed'));
    } finally {
      setBusy(null);
    }
  };

  return { found, open, busy, pct, msg, check, install, close: () => setOpen(false), configured: updatesConfigured() };
}

export type Updater = ReturnType<typeof useUpdater>;

/** "Nueva versión X disponible" sheet: notes, progress, Actualizar / Después. */
export function UpdateSheet({ u }: { u: Updater }) {
  const { t } = useTranslation('mobile');
  const dl = u.busy === 'download';
  return (
    <SheetModal visible={u.open && !!u.found} onClose={dl ? undefined : u.close} testID="update-sheet">
      <AppText variant="title">{t('update.available', { v: u.found?.version })}</AppText>
      {!!u.found?.notes && (
        <ScrollView style={styles.notes}>
          <AppText variant="body" color={colors.textSecondary}>{u.found.notes}</AppText>
        </ScrollView>
      )}
      {dl && (
        <View style={styles.track} accessibilityRole="progressbar">
          <View style={[styles.fill, { width: `${Math.round(u.pct * 100)}%` }]} />
        </View>
      )}
      {!!u.msg && <AppText variant="label" color={colors.dangerText}>{u.msg}</AppText>}
      <AppButton label={dl ? t('update.downloading', { pct: Math.round(u.pct * 100) }) : t('update.install')} icon="download" size="lg" fullWidth loading={dl} onPress={() => void u.install()} testID="update-install" />
      <AppButton label={t('update.later')} variant="ghost" size="lg" fullWidth disabled={dl} onPress={u.close} testID="update-later" />
    </SheetModal>
  );
}

/** Mounted once per signed-in role group: silent throttled check at start. */
export function AutoUpdate() {
  const u = useUpdater();
  const { check } = u;
  useEffect(() => {
    if (u.configured) void check(false);
  }, [u.configured, check]);
  return <UpdateSheet u={u} />;
}

const styles = StyleSheet.create({
  notes: { maxHeight: 160 },
  track: { height: 8, borderRadius: radii.lg, backgroundColor: colors.surfaceRaised, overflow: 'hidden' },
  fill: { height: 8, backgroundColor: colors.primary },
});
