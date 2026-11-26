import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../../components/AppText';
import { colors, radii, spacing, touch } from '../../../theme/tokens';
import { EXPRESS_ID } from '../openTable/OpenTableScreen';
import { useWaitingList } from '../waiting/useWaiting';

/** Header left: "Rápido" (EXPRESS ticket, no table). */
export function ExpressButton() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  return (
    <Pressable
      testID="floor-express"
      accessibilityRole="button"
      accessibilityLabel={t('waiter.floor.expressA11y')}
      onPress={() => router.push(`/open-table/${EXPRESS_ID}`)}
      style={({ pressed }) => [styles.express, { opacity: pressed ? 0.8 : 1 }]}
    >
      <MaterialCommunityIcons name="flash" size={18} color={colors.textOnAccent} />
      <AppText variant="label" bold color={colors.textOnAccent}>
        {t('waiter.floor.express')}
      </AppText>
    </Pressable>
  );
}

/** Header right: waiting-list icon with the number of parties waiting. */
export function WaitingButton() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const n = useWaitingList().entries.length;
  return (
    <Pressable
      testID="floor-waiting"
      accessibilityRole="button"
      accessibilityLabel={t('waiter.floor.waitingA11y', { n })}
      hitSlop={touch.hitSlop}
      onPress={() => router.push('/waiting')}
      style={styles.waiting}
    >
      <MaterialCommunityIcons name="account-clock-outline" size={26} color={colors.textPrimary} />
      {n > 0 && (
        <View style={styles.badge} testID="floor-waiting-badge">
          <AppText variant="caption" bold color={colors.textOnAccent}>
            {n > 99 ? '99+' : n}
          </AppText>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  express: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: spacing.s1, paddingHorizontal: spacing.s3, borderRadius: radii.pill, backgroundColor: colors.primary },
  waiting: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', top: 2, right: 0, minWidth: 18, height: 18, paddingHorizontal: 4, borderRadius: 9, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
});
