import { useCanGoBack } from '../../src/utils/useCanGoBack';
import { stationForRole } from '../../src/features/kitchen/kdsModel';
import { KdsFocusEffects } from '../../src/features/kitchen/KdsFocusEffects';
import { KdsScreen } from '../../src/features/kitchen/KdsScreen';
import { useAuthStore } from '../../src/state/authStore';

/** SCR-K-01. KITCHEN_STAFF -> kitchen, BAR_STAFF -> bar; managers/admins viewing this group get the station switch. */
export default function Queue() {
  const canBack = useCanGoBack();
  const role = useAuthStore((s) => s.user?.role);
  return (
    <>
      <KdsScreen fixedStation={stationForRole(role)} />
      {/* Swallow hardware back only on the kiosk root; when pushed (admin/manager) it must pop. */}
      <KdsFocusEffects blockBack={!canBack} />
    </>
  );
}
