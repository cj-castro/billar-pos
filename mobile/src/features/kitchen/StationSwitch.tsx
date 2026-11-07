import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../components/AppText';
import type { Station } from '../../domain/types';
import { colors, radii } from '../../theme/tokens';

export function StationSwitch({ value, onChange }: { value: Station; onChange: (s: Station) => void }) {
  const { t } = useTranslation('mobile');
  return (
    <View style={styles.switch} accessibilityRole="tablist" accessibilityLabel={t('kitchen.stationSwitch')}>
      {(['KITCHEN', 'BAR'] as const).map((s) => (
        <Pressable
          key={s}
          testID={`station-${s}`}
          accessibilityRole="tab"
          accessibilityLabel={t(`kitchen.station.${s}`)}
          accessibilityState={{ selected: value === s }}
          onPress={() => onChange(s)}
          style={[styles.seg, value === s && styles.segOn]}
        >
          <AppText variant="body" bold color={value === s ? colors.textOnAccent : colors.textSecondary}>
            {t(`kitchen.station.${s}`)}
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  switch: { flexDirection: 'row', backgroundColor: colors.surfaceRaised, borderRadius: radii.pill, padding: 2 },
  seg: { minHeight: 40, paddingHorizontal: 12, borderRadius: radii.pill, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.primary },
});
