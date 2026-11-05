import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { setLanguage, type Lang } from '../i18n';
import { colors, radii, spacing, touch } from '../theme/tokens';
import { haptic } from '../utils/haptics';
import { AppText } from './AppText';

/** ES | EN segmented control; persists via i18n.setLanguage. */
export function LanguageToggle({ testID = 'lang-toggle' }: { testID?: string }) {
  const { t, i18n } = useTranslation('mobile');
  const current: Lang = i18n.language?.startsWith('en') ? 'en' : 'es';
  return (
    <View testID={testID} style={styles.row} accessibilityRole="radiogroup" accessibilityLabel={t('lang.toggle')}>
      {(['es', 'en'] as const).map((l) => {
        const on = l === current;
        return (
          <Pressable
            key={l}
            testID={`${testID}-${l}`}
            accessibilityRole="radio"
            accessibilityLabel={t(`lang.${l}`)}
            accessibilityState={{ selected: on }}
            onPress={() => {
              if (on) return;
              haptic.selection();
              void setLanguage(l);
            }}
            style={[styles.seg, on && styles.on]}
          >
            <AppText variant="body" bold color={on ? colors.textOnAccent : colors.textPrimary}>
              {l.toUpperCase()}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignSelf: 'center', backgroundColor: colors.surfaceRaised, borderRadius: radii.md, padding: 4, gap: 4 },
  seg: { minWidth: 64, minHeight: touch.min - 8, paddingHorizontal: spacing.s4, borderRadius: radii.md - 4, alignItems: 'center', justifyContent: 'center' },
  on: { backgroundColor: colors.primary },
});
