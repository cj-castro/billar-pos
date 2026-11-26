import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import '../../../i18n';
import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, waitFor } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import client from '../../../api/client';
import { ToastProvider } from '../../../components/Toast';
import type { MenuItem, Resource, Ticket, TicketLineItem } from '../../../domain/types';
import { useConnectionStore } from '../../../realtime/socket';
import { createQueryClient } from '../../../state/queryClient';
import { mockServerConfig } from '../../../test/utils';

export interface Call {
  method: string;
  url: string;
  data: unknown;
  params?: Record<string, unknown>;
  headers: Record<string, string>;
}
type Reply = { status?: number; data?: unknown } | Error;
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

/** Route table keyed "METHOD /path" (exact) or with a RegExp-source suffix: "POST /tickets/[^/]+/items". Records every call. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const entries = Object.entries(routes).map(([k, h]) => {
    const [method, ...rest] = k.split(' ');
    return { method, re: new RegExp(`^${rest.join(' ')}$`), h };
  });
  const adapter: AxiosAdapter = async (cfg: InternalAxiosRequestConfig) => {
    const method = (cfg.method ?? 'get').toUpperCase();
    const url = cfg.url ?? '';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.headers?.toJSON?.() ?? {})) headers[k] = String(v);
    let data: unknown = cfg.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        // keep raw
      }
    }
    const call: Call = { method, url, data, params: cfg.params, headers };
    calls.push(call);
    const hit = entries.find((e) => e.method === method && e.re.test(url));
    if (!hit) {
      const response = { status: 404, statusText: '', headers: {}, config: cfg, data: { error: 'NOT_MOCKED', url } };
      throw new AxiosError('x', 'ERR_BAD_REQUEST', cfg, null, response);
    }
    const reply = typeof hit.h === 'function' ? await hit.h(call) : hit.h;
    if (reply instanceof Error) throw reply;
    const status = reply.status ?? 200;
    const response = { status, statusText: '', headers: {}, config: cfg, data: reply.data };
    if (status < 300) return response;
    throw new AxiosError('x', 'ERR_BAD_REQUEST', cfg, null, response);
  };
  client.defaults.adapter = adapter;
  return {
    calls,
    of: (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.url)),
  };
}

/** AxiosError with no response = what the client maps to a network error. */
export const networkError = () => new AxiosError('Network Error', 'ERR_NETWORK', { headers: {} } as InternalAxiosRequestConfig);
export const httpError = (status: number, error: string, message?: string): Reply => ({ status, data: { error, ...(message ? { message } : {}) } });

/** Set the connection before rendering (no act needed). */
export function online(on = true) {
  useConnectionStore.setState({ state: on ? 'connected' : 'disconnected' });
}

/** Flip the connection while a screen is mounted. */
export async function setOnline(on: boolean) {
  await act(async () => online(on));
}

let clients: QueryClient[] = [];
// react-query gc timers (1 h / 5 min) would keep the jest process alive: tests use Infinity (= no timer).
export const testQueryClient = () => {
  const qc = createQueryClient();
  qc.setDefaultOptions({ ...qc.getDefaultOptions(), queries: { ...qc.getDefaultOptions().queries, gcTime: Infinity, retryDelay: 0 }, mutations: { ...qc.getDefaultOptions().mutations, gcTime: Infinity } });
  clients.push(qc);
  return qc;
};
afterEach(async () => {
  // let in-flight mutations/refetches finish so module-level send guards do not leak into the next test
  await Promise.all(clients.map((c) => waitFor(() => expect(c.isMutating() + c.isFetching()).toBe(0), { timeout: 3000 }).catch(() => {})));
  clients.forEach((c) => c.clear());
  clients = [];
});

const SAFE_AREA = { frame: { x: 0, y: 0, width: 360, height: 800 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

export async function renderScreen(ui: ReactElement) {
  mockServerConfig();
  const queryClient = testQueryClient();
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <SafeAreaProvider initialMetrics={SAFE_AREA}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>{children}</ToastProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
  const r = await render(ui, { wrapper: Wrapper });
  return { queryClient, ...r };
}

// ------------------------------------------------------------------ fixtures
export const resource = (over: Partial<Resource>): Resource => ({
  id: 'r1',
  code: 'T1',
  name: 'Mesa 1',
  type: 'REGULAR_TABLE',
  status: 'AVAILABLE',
  is_active: true,
  is_temp: false,
  sort_order: 0,
  ...over,
});

export const line = (over: Partial<TicketLineItem>): TicketLineItem => ({
  id: 'l1',
  ticket_id: 't1',
  menu_item_id: 'm1',
  menu_item_name: 'Alitas BBQ',
  quantity: 1,
  unit_price_cents: 14500,
  promo_discount_cents: 0,
  net_cents: 14500,
  promotions: [],
  status: 'SENT',
  routing_dest: 'KITCHEN',
  sent_at: '2026-01-01T10:00:00+00:00',
  served_at: null,
  voided_at: null,
  void_reason: null,
  notes: null,
  needs_reprint: false,
  modifiers: [],
  ...over,
});

export const ticket = (over: Partial<Ticket>): Ticket => ({
  id: 't1',
  ticket_type: 'TABLE',
  rappi_order_id: null,
  resource_id: 'r1',
  resource_code: 'T1',
  status: 'OPEN',
  opened_by: 'u-waiter',
  opened_at: '2026-01-01T10:00:00+00:00',
  closed_at: null,
  payment_type: null,
  tendered_cents: null,
  tip_cents: null,
  manual_discount_pct: null,
  was_reopened: false,
  payment_requested: false,
  payment_requested_at: null,
  subtotal_cents: 14500,
  discount_cents: 0,
  pool_time_cents: 0,
  total_cents: 14500,
  version: 3,
  notes: null,
  customer_name: null,
  line_items: [line({})],
  timer_sessions: [],
  ...over,
});

export const menuItem = (over: Partial<MenuItem>): MenuItem => ({
  id: 'm1',
  category_id: 'c1',
  name: 'Cerveza',
  price_cents: 4500,
  requires_flavor: false,
  is_active: true,
  sort_order: 0,
  routing: 'BAR',
  modifier_groups: [],
  ...over,
});

/** `expo-router` mock shared by the screen tests (jest.mock hoists: re-declare in each file). */
export const makeRouter = () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: jest.fn(() => true), dismissTo: jest.fn() });
