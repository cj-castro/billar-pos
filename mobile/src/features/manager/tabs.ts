export interface ManagerTabs {
  /** Visible bottom tabs, in order. */
  bar: ('overview' | 'tickets' | 'floor-view' | 'caja' | 'reportes' | 'mas')[];
  /** Entries of the "Mas" list. */
  more: ('kds' | 'waiting' | 'floor' | 'system' | 'profile')[];
}

/**
 * V2 tabs. MANAGER: Resumen, Tickets, Piso, Caja, Mas. ADMIN: Resumen, Tickets, Caja, Reportes, Mas
 * (Piso, Cocina/Barra, Lista de espera, Sistema and Yo live under Mas). Anything else gets the manager set
 * (the group guard keeps other roles out anyway).
 */
export function managerTabsFor(role: string | null | undefined): ManagerTabs {
  if (role === 'ADMIN') return { bar: ['overview', 'tickets', 'caja', 'reportes', 'mas'], more: ['kds', 'waiting', 'floor', 'system', 'profile'] };
  return { bar: ['overview', 'tickets', 'floor-view', 'caja', 'mas'], more: ['kds', 'waiting', 'profile'] };
}
