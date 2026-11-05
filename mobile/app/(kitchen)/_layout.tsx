import { GroupGuard } from '../../src/components/GroupGuard';

/** KITCHEN_STAFF / BAR_STAFF: one screen, no tabs (kiosk-like). Managers/admins may view. */
export default function Layout() {
  return <GroupGuard group="(kitchen)" />;
}