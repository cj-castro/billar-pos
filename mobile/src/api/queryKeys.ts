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
