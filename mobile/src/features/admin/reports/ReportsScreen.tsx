import { useQueryClient } from '@tanstack/react-query';
import { Redirect } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { exportSalesCsv } from '../../../api/endpoints/reports';
import { AppButton } from '../../../components/AppButton';
import { AppText } from '../../../components/AppText';
import { AppTextField } from '../../../components/AppTextField';
import { ConnectionPill } from '../../../components/ConnectionPill';
import { OfflineBanner } from '../../../components/OfflineBanner';
import { ScreenHeader } from '../../../components/ScreenHeader';
import { ScreenScaffold } from '../../../components/ScreenScaffold';
import { useToast } from '../../../components/Toast';
import { useAuthStore } from '../../../state/authStore';
import { colors, radii, spacing } from '../../../theme/tokens';
import { errorMessage } from '../../../utils/errorMessage';
import { CategoryCard, EarningsCard, PeakCard, PoolCard, PromosCard, SafeCard, SalesCard, SessionsCard, StaffCard, VoidsCard } from './cards';
import { isValidYmd, mexicoToday, rangeFor, type DateRange, type Preset } from './dateRange';

const PRESETS: Preset[] = ['today', 'yesterday', 'week', 'month', 'range'];

/** SCR-A-02 Reportes. ADMIN sees everything; MANAGER the sales/ops cards (server allows them), without earnings/safe. */
export function ReportsScreen() {
  const role = useAuthStore((s) => s.user?.role);
  if (role !== 'ADMIN' && role !== 'MANAGER') return <Redirect href="/denied" />;
  return <ReportsContent admin={role === 'ADMIN'} />;
}

function ReportsContent({ admin }: { admin: boolean }) {
  const { t } = useTranslation('mobile');
  const toast = useToast();
  const qc = useQueryClient();
  const today = useMemo(() => mexicoToday(), []);
  const [preset, setPreset] = useState<Preset>('today');
  const [custom, setCustom] = useState<DateRange | undefined>();
  const [draft, setDraft] = useState<DateRange>({ from: today, to: today });
  const [draftError, setDraftError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const r = useMemo(() => rangeFor(preset, today, custom), [preset, today, custom]);

  const apply = () => {
    if (isValidYmd(draft.from) && isValidYmd(draft.to) && draft.from <= draft.to) {
      setDraftError(false);
      setCustom(draft);
    } else setDraftError(true);
  };
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([qc.invalidateQueries({ queryKey: ['reports'] }), qc.invalidateQueries({ queryKey: ['safe'] })]);
    setRefreshing(false);
  };
  // expo-sharing is not installed; RN's built-in Share sheet carries the CSV as text.
  const exportCsv = async () => {
    setExporting(true);
    try {
      await Share.share({ title: `ventas-${r.from}_${r.to}.csv`, message: await exportSalesCsv(r) });
    } catch (e) {
      toast.show({ tone: 'error', title: t('reports.exportFailed'), message: errorMessage(e) });
    } finally {
      setExporting(false);
    }
  };

  return (
    <ScreenScaffold testID="screen-reportes" padded={false} edges={['top']} header={<ScreenHeader title={t('reports.title')} subtitle={r.from === r.to ? r.from : `${r.from} → ${r.to}`} right={<ConnectionPill />} />} banner={<OfflineBanner />}>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />} showsVerticalScrollIndicator={false}>
        <View style={styles.chips}>
          {PRESETS.map((p) => (
            <Pressable
              key={p}
              testID={`preset-${p}`}
              accessibilityRole="button"
              accessibilityState={{ selected: preset === p }}
              onPress={() => setPreset(p)}
              style={[styles.chip, preset === p && styles.chipOn]}
            >
              <AppText variant="label" bold color={preset === p ? colors.textOnAccent : colors.textPrimary}>
                {t(`reports.presets.${p}`)}
              </AppText>
            </Pressable>
          ))}
        </View>
        {preset === 'range' && (
          <View style={styles.range}>
            <AppTextField label={t('reports.from')} value={draft.from} onChangeText={(from) => setDraft((d) => ({ ...d, from }))} keyboardType="numbers-and-punctuation" maxLength={10} testID="range-from" />
            <AppTextField label={t('reports.to')} value={draft.to} onChangeText={(to) => setDraft((d) => ({ ...d, to }))} keyboardType="numbers-and-punctuation" maxLength={10} testID="range-to" error={draftError ? t('reports.invalidRange') : null} />
            <AppButton testID="range-apply" label={t('reports.apply')} onPress={apply} />
          </View>
        )}

        <SalesCard r={r} />
        <CategoryCard r={r} />
        <StaffCard r={r} />
        <PoolCard r={r} />
        <PeakCard r={r} />
        <VoidsCard r={r} />
        <PromosCard r={r} />
        {admin && <EarningsCard r={r} />}
        {admin && <SafeCard r={r} />}
        <SessionsCard />
        <AppButton testID="export-csv" label={t('reports.exportCsv')} icon="share-variant-outline" variant="secondary" fullWidth loading={exporting} onPress={() => void exportCsv()} />
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.s4, gap: spacing.s4, paddingBottom: spacing.s8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.s2 },
  chip: { minHeight: 44, paddingHorizontal: spacing.s4, borderRadius: radii.pill, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: colors.primary },
  range: { gap: spacing.s3 },
});
