import { useRouter } from 'expo-router';
import { StyleSheet, Text } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '../src/components/Button';
import { Screen } from '../src/components/Screen';
import { useAuthStore } from '../src/state/authStore';
import { colors, font } from '../src/theme/tokens';

export default function DeniedScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const logout = useAuthStore((s) => s.logout);
  return (
    <Screen>
      <Text style={styles.title}>{t('denied.title')}</Text>
      <Text style={styles.body}>{t('denied.body')}</Text>
      <Button
        title={t('logout')}
        variant="secondary"
        onPress={async () => {
          await logout();
          router.replace('/login');
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.text, fontSize: font.xl, fontWeight: '700' },
  body: { color: colors.textMuted, fontSize: font.md },
});
