import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { colors, spacing } from '../theme/tokens';
import { AppText } from './AppText';

/** Small uppercase section label (Floor groups, Settings) with an optional right slot (counts). */
export function SectionHeader({ title, right, testID }: { title: string; right?: ReactNode; testID?: string }) {
  return (
    <View testID={testID} style={styles.row}>
      <AppText variant="label" bold color={colors.textSecondary} style={styles.title} accessibilityRole="header">
        {title.toUpperCase()}
      </AppText>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32, paddingTop: spacing.s2 },
  title: { letterSpacing: 0.6 },
});
