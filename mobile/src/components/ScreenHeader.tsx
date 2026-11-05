import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { colors, layout, spacing } from '../theme/tokens';
import { AppText } from './AppText';
import { IconButton } from './IconButton';

export interface ScreenHeaderProps {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  /** e.g. <ConnectionPill />. */
  right?: ReactNode;
  testID?: string;
}

/** 56 dp top bar (surface bg). Safe-area top inset is handled by ScreenScaffold. */
export function ScreenHeader({ title, subtitle, onBack, right, testID = 'screen-header' }: ScreenHeaderProps) {
  const { t } = useTranslation('mobile');
  return (
    <View testID={testID} style={styles.bar}>
      {onBack && <IconButton icon="arrow-left" accessibilityLabel={t('back')} onPress={onBack} testID="header-back" />}
      <View style={styles.titles}>
        <AppText variant="title" numberOfLines={1} accessibilityRole="header">
          {title}
        </AppText>
        {!!subtitle && (
          <AppText variant="label" color={colors.textSecondary} numberOfLines={1}>
            {subtitle}
          </AppText>
        )}
      </View>
      {right && <View style={styles.right}>{right}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { minHeight: layout.topBarHeight, flexDirection: 'row', alignItems: 'center', gap: spacing.s2, paddingHorizontal: spacing.s4, backgroundColor: colors.surface },
  right: { alignSelf: 'center' },
  titles: { flex: 1, justifyContent: 'center' },
});
