import type { DateParams } from './endpoints/reports';

/** Central TanStack Query keys. The realtime invalidation map (realtime/socket.ts) depends on these shapes. */
export const qk = {
  resources: ['resources'] as const,
  ticket: (id: string) => ['ticket', id] as const,
  tickets: ['tickets'] as const,
  queue: (station: 'KITCHEN' | 'BAR') => ['queue', station] as const,
  queueCounts: ['queue', 'counts'] as const,
  waiting: ['waiting'] as const,
  settings: (key?: string) => (key ? (['settings', key] as const) : (['settings'] as const)),
  menu: ['menu'] as const,
  cash: ['cash'] as const,
  stock: ['stock'] as const,
};

/** v2 query keys. Each sits under an existing root so the shared socket invalidation reaches it. */
export const qk2 = {
  /** Under `resources`: refreshed by every floor:update. */
  activeExpress: [...qk.resources, 'active-express'] as const,
  /** Under `waiting`: refreshed by waiting:update AND waiting_list:update. */
  waitingList: [...qk.waiting, 'list'] as const,
};

/** Manager keys. */
export const qkm = {
  cashSummary: [...qk.cash, 'summary'] as const,
  cashSessions: [...qk.cash, 'sessions'] as const,
  cashTickets: [...qk.cash, 'tickets'] as const,
  /** status = OPEN | CLOSED | CANCELLED */
  ticketsByStatus: (status: string) => [...qk.tickets, 'by-status', status] as const,
  editHistory: (id: string) => [...qk.ticket(id), 'edit-history'] as const,
  voidsToday: (day: string) => ['reports', 'voids', day] as const,
};

export const qkKds = {
  setting: (key: string) => ['kds', 'setting', key] as const,
};

export const qkr = {
  report: (name: string, p?: DateParams) => ['reports', name, p?.from ?? '', p?.to ?? ''] as const,
  safe: (p: DateParams) => ['safe', p.from, p.to] as const,
  cashSessions: ['reports', 'cash-sessions'] as const,
  cashSummary: (id: string) => ['reports', 'cash-summary', id] as const,
};
