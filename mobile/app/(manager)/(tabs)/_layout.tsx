import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { tabIcon, tabScreenOptions } from '../../../src/components/tabBar';
import { managerTabVisibility } from '../../../src/features/manager/tabs';
import { usePrintFailureListener } from '../../../src/features/manager/printFailures';
import { useAuthStore } from '../../../src/state/authStore';

/** MANAGER: Resumen, Tickets, Piso, Cocina/Barra, Yo. ADMIN: Resumen, Tickets, Piso, Sistema, Yo. */
export default function TabsLayout() {
  const { t } = useTranslation('mobile');
  const vis = managerTabVisibility(useAuthStore((s) => s.user?.role));
  usePrintFailureListener(); // alerts must accumulate even while the overview tab is not focused
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="overview" options={{ title: t('tabs.overview'), tabBarIcon: tabIcon('chart-box-outline') }} />
      <Tabs.Screen name="tickets" options={{ title: t('tabs.tickets'), tabBarIcon: tabIcon('receipt-text-outline') }} />
      <Tabs.Screen name="floor-view" options={{ title: t('tabs.floorView'), tabBarIcon: tabIcon('table-furniture') }} />
      <Tabs.Screen name="kds" options={{ title: t('tabs.kds'), tabBarIcon: tabIcon('silverware-fork-knife'), href: vis.kds ? undefined : null }} />
      <Tabs.Screen name="system" options={{ title: t('tabs.system'), tabBarIcon: tabIcon('tune-variant'), href: vis.system ? undefined : null }} />
      <Tabs.Screen name="profile" options={{ title: t('tabs.me'), tabBarIcon: tabIcon('account-outline') }} />
    </Tabs>
  );
}
