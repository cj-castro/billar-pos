import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useConnectionStore, type ConnectionState } from '../realtime/socket';
import { colors, font, radius } from '../theme/tokens';

const DOT: Record<ConnectionState, string> = {
  connected: colors.success,
  connecting: colors.warning,
  reconnecting: colors.warning,
  disconnected: colors.danger,
};

export function ConnectionPill() {
  const { t } = useTranslation('mobile');
  const state = useConnectionStore((s) => s.state);
  return (
    <View style={styles.pill} accessibilityRole="text" accessibilityLabel={t(`connection.${state}`)}>
      <View style={[styles.dot, { backgroundColor: DOT[state] }]} />
      <Text style={styles.text}>{t(`connection.${state}`)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { color: colors.textMuted, fontSize: font.sm },
});
