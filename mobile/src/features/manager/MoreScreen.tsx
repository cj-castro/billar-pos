import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { AppText } from '../../components/AppText';
import { ScreenHeader } from '../../components/ScreenHeader';
import { ScreenScaffold } from '../../components/ScreenScaffold';
import { useAuthStore } from '../../state/authStore';
import { colors, radii, spacing, type IconName } from '../../theme/tokens';
import { managerTabsFor, type ManagerTabs } from './tabs';

type Entry = ManagerTabs['more'][number];
const ENTRIES: Record<Entry, { icon: IconName; label: string; href: (role: string | undefined) => Href }> = {
  // MANAGER has the Cocina/Barra tab route; ADMIN reaches the same display through the kitchen group.
  kds: { icon: 'silverware-fork-knife', label: 'mgr.more.kds', href: (r) => (r === 'ADMIN' ? '/queue' : '/kds') },
  waiting: { icon: 'account-clock-outline', label: 'mgr.more.waiting', href: () => '/waiting' },
  floor: { icon: 'table-furniture', label: 'mgr.more.floor', href: () => '/floor-view' },
  system: { icon: 'tune-variant', label: 'mgr.more.system', href: () => '/system' },
  profile: { icon: 'account-outline', label: 'mgr.more.me', href: () => '/profile' },
};

/** "Mas": the secondary destinations of the manager / admin tab bar. */
export function MoreScreen() {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  const role = useAuthStore((s) => s.user?.role);
  const items = managerTabsFor(role).more;
  return (
    <ScreenScaffold testID="screen-more" padded={false} edges={['top']} header={<ScreenHeader title={t('mgr.more.title')} />}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.list}>
          {items.map((k) => {
            const e = ENTRIES[k];
            return (
              <Pressable key={k} testID={`more-${k}`} accessibilityRole="button" accessibilityLabel={t(e.label)} onPress={() => router.push(e.href(role))} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
                <MaterialCommunityIcons name={e.icon} size={24} color={colors.textPrimary} />
                <AppText variant="body" style={styles.label}>
                  {t(e.label)}
                </AppText>
                <MaterialCommunityIcons name="chevron-right" size={22} color={colors.textMuted} />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </ScreenScaffold>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.s4 },
  list: { borderRadius: radii.md, backgroundColor: colors.surface, overflow: 'hidden' },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.s3, paddingHorizontal: spacing.s3, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  label: { flex: 1 },
});
