import { Tabs } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { tabIcon, tabScreenOptions } from '../../../src/components/tabBar';
import { usePrintFailureListener } from '../../../src/features/manager/printFailures';
import { managerTabsFor } from '../../../src/features/manager/tabs';
import { useAuthStore } from '../../../src/state/authStore';

const hide = { tabBarItemStyle: { display: 'none' as const } };

/** MANAGER: Resumen, Tickets, Piso, Caja, Mas. ADMIN: Resumen, Tickets, Caja, Reportes, Mas. The rest are reached from Mas (tab item display:none, route kept). */
export default function TabsLayout() {
  const { t } = useTranslation('mobile');
  const bar = managerTabsFor(useAuthStore((s) => s.user?.role)).bar;
  // Not `href: null`: expo-router 58 marks those tabs `hidden`, and navigating to a hidden tab redirects back to the first one (Resumen).
  const href = (name: (typeof bar)[number]) => (bar.includes(name) ? {} : hide);
  usePrintFailureListener(); // alerts must accumulate even while the overview tab is not focused
  return (
    <Tabs screenOptions={tabScreenOptions}>
      <Tabs.Screen name="overview" options={{ title: t('tabs.overview'), tabBarIcon: tabIcon('chart-box-outline') }} />
      <Tabs.Screen name="tickets" options={{ title: t('tabs.tickets'), tabBarIcon: tabIcon('receipt-text-outline') }} />
      <Tabs.Screen name="floor-view" options={{ title: t('tabs.floorView'), tabBarIcon: tabIcon('table-furniture'), ...href('floor-view') }} />
      <Tabs.Screen name="caja" options={{ title: t('mgr.tabs.cash'), tabBarIcon: tabIcon('cash-register') }} />
      <Tabs.Screen name="reportes" options={{ title: t('mgr.tabs.reports'), tabBarIcon: tabIcon('chart-line'), ...href('reportes') }} />
      <Tabs.Screen name="mas" options={{ title: t('mgr.tabs.more'), tabBarIcon: tabIcon('dots-horizontal') }} />
      <Tabs.Screen name="kds" options={{ title: t('tabs.kds'), ...hide }} />
      <Tabs.Screen name="system" options={{ title: t('tabs.system'), ...hide }} />
      <Tabs.Screen name="profile" options={{ title: t('tabs.me'), ...hide }} />
    </Tabs>
  );
}
