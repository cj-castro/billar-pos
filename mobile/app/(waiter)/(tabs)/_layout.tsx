import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { tabIcon, tabScreenOptions } from '../../../src/components/tabBar';
import { useReady } from '../../../src/features/waiter/queries';

export default function TabsLayout() {
  const { t } = useTranslation('mobile');
  // Badge = READY lines of tickets I opened (shares the queries with the Listos tab).
  const { model } = useReady();
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="floor" options={{ title: t('tabs.floor'), tabBarIcon: tabIcon('table-furniture') }} />
      <Tabs.Screen
        name="ready"
        options={{ title: t('tabs.ready'), tabBarIcon: tabIcon('bell-outline'), tabBarBadge: model.mineCount > 0 ? model.mineCount : undefined }}
      />
      <Tabs.Screen name="me" options={{ title: t('tabs.me'), tabBarIcon: tabIcon('account-outline') }} />
    </Tabs>
  );
}
