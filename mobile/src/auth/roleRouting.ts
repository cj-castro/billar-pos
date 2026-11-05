import type { Station } from '../domain/types';

export type RouteGroup = '(waiter)' | '(kitchen)' | '(manager)' | '(admin)';

export interface RoleTarget {
  /** Route group the role lives in. */
  group: RouteGroup;
  /** Concrete href to navigate to. */
  href: '/floor' | '/queue' | '/overview' | '/diagnostics' | '/denied';
  /** KDS station for the (kitchen) group. */
  station?: Station;
}

const DENIED: RoleTarget = { group: '(waiter)', href: '/denied' };

/** D9 / web LoginPage redirect. Unknown roles -> /denied. */
export function routeForRole(role: string | null | undefined): RoleTarget {
  switch (role) {
    case 'WAITER':
      return { group: '(waiter)', href: '/floor' };
    case 'KITCHEN_STAFF':
      return { group: '(kitchen)', href: '/queue', station: 'KITCHEN' };
    case 'BAR_STAFF':
      return { group: '(kitchen)', href: '/queue', station: 'BAR' };
    case 'MANAGER':
      return { group: '(manager)', href: '/overview' };
    case 'ADMIN':
      return { group: '(admin)', href: '/diagnostics' };
    default:
      return DENIED;
  }
}

export function isKnownRole(role: string | null | undefined): boolean {
  return routeForRole(role) !== DENIED;
}

/**
 * Group guard used by each group's `_layout.tsx`.
 * Managers/admins may also open the waiter and kitchen groups (D9: "+ floor/KDS read");
 * admins may open the manager group. Everyone else only their own.
 */
export function canAccess(role: string | null | undefined, group: RouteGroup): boolean {
  switch (role) {
    case 'WAITER':
      return group === '(waiter)';
    case 'KITCHEN_STAFF':
    case 'BAR_STAFF':
      return group === '(kitchen)';
    case 'MANAGER':
      return group === '(manager)' || group === '(waiter)' || group === '(kitchen)';
    case 'ADMIN':
      return true;
    default:
      return false;
  }
}
