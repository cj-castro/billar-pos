/** Manager tab bar rules (R1): the KDS tab is for MANAGER, the system tab for ADMIN only. */
export function managerTabVisibility(role: string | null | undefined): { kds: boolean; system: boolean } {
  return { kds: role === 'MANAGER', system: role === 'ADMIN' };
}
