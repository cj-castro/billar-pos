import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { tabIcon, tabScreenOptions } from '../../../src/components/tabBar';

export default function TabsLayout() {
  const { t } = useTranslation('mobile');
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="floor" options={{ title: t('tabs.floor'), tabBarIcon: tabIcon('table-furniture') }} />
      {/* TODO(waiter agent): tabBarBadge = count of READY lines of my tickets. */}
      <Tabs.Screen name="ready" options={{ title: t('tabs.ready'), tabBarIcon: tabIcon('bell-outline') }} />
      <Tabs.Screen name="me" options={{ title: t('tabs.me'), tabBarIcon: tabIcon('account-outline') }} />
    </Tabs>
  );
}