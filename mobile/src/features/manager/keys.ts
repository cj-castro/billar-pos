import { qk } from '../../api/queryKeys';

/** Manager query keys, nested under the shared roots so existing invalidations still reach them. */
export const mk = {
  cashStatus: [...qk.cash, 'status'] as const,
  openAll: [...qk.tickets, 'open-all'] as const,
  pending: [...qk.tickets, 'pending-payment'] as const,
};
export const MANAGER_POLL_MS = 30_000;
