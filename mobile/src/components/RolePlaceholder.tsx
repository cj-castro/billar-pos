import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { routeForRole } from '../auth/roleRouting';
import { useAuthStore } from '../state/authStore';
import { colors, font } from '../theme/tokens';
import { Button } from './Button';
import { ConnectionPill } from './ConnectionPill';
import { Screen } from './Screen';

/** Temporary body for every role group until feature screens land. */
export function RolePlaceholder({ group }: { group: 'waiter' | 'kitchen' | 'manager' | 'admin' }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const station = user ? routeForRole(user.role).station : undefined;

  const onLogout = async () => {
    await logout();
    router.replace('/login');
  };

  return (
    <Screen>
      <ConnectionPill />
      <View style={{ gap: 8 }}>
        <Text style={styles.title}>{t(`groups.${group}`)}</Text>
        <Text style={styles.muted} testID="role-line">
          {t('roleLabel')}: {user?.role}
          {station ? ` · ${station}` : ''}
        </Text>
        <Text style={styles.muted}>{user?.name}</Text>
        <Text style={styles.body}>{t('underConstruction')}</Text>
      </View>
      <Button title={t('logout')} variant="secondary" onPress={onLogout} testID="logout" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.xl, fontWeight: '700' },
  muted: { color: colors.textMuted, fontSize: font.md },
  body: { color: colors.text, fontSize: font.lg, marginTop: 16 },
});
