/// <reference types="node" />
/**
 * Helpers for contract tests (`npm run test:contract`) against the REAL local backend
 * (docker project `billarmobile`, http://localhost:8090). Not used by unit tests.
 *
 * LOGIN IS RATE-LIMITED (10/min, shared bucket across everything on this machine): tokens are cached in
 * memory and in a file under the OS temp dir (valid while the JWT has > 60 s left), so a whole run logs in
 * at most once per role no matter how many test files execute.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const BASE = process.env.CONTRACT_BASE_URL ?? 'http://localhost:8090';
export const API = `${BASE}/api/v1`;

export type Who = 'kitchen' | 'bar' | 'manager' | 'admin' | 'waiter';
export const CREDENTIALS: Record<Who, { username: string; password: string }> = {
  kitchen: { username: 'kitchen', password: 'kitchen123' },
  bar: { username: 'barstaff', password: 'bar123' },
  manager: { username: 'manager', password: 'manager123' },
  admin: { username: 'admin', password: 'admin123' },
  waiter: { username: 'waiter1', password: 'waiter123' },
};
export const MANAGER_PIN = '5678';

export interface Session {
  access_token: string;
  refresh_token: string;
  user: { id: string; username: string; name: string; role: string };
}

const CACHE = path.join(os.tmpdir(), 'bola8-contract-sessions.json');
const memo = new Map<Who, Session>();

function expiresInSec(jwt: string): number {
  try {
    const exp = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()).exp as number;
    return exp - Date.now() / 1000;
  } catch {
    return -1;
  }
}

function readCache(): Partial<Record<Who, Session>> {
  try {
    return JSON.parse(fs.readFileSync(CACHE, 'utf8'));
  } catch {
    return {};
  }
}

export async function sessionFor(who: Who): Promise<Session> {
  const hit = memo.get(who);
  if (hit && expiresInSec(hit.access_token) > 60) return hit;
  const cached = readCache()[who];
  if (cached && expiresInSec(cached.access_token) > 60) {
    memo.set(who, cached);
    return cached;
  }
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(CREDENTIALS[who]),
  });
  if (res.status === 429) throw new Error('Login rate-limited (10/min shared). Wait a minute and re-run.');
  if (!res.ok) throw new Error(`login ${who} -> ${res.status}`);
  const s = (await res.json()) as Session;
  memo.set(who, s);
  try {
    fs.writeFileSync(CACHE, JSON.stringify({ ...readCache(), [who]: s }));
  } catch {
    /* cache is best effort */
  }
  return s;
}

export interface Res<T = any> {
  status: number;
  body: T;
}

export async function call<T = any>(who: Who, method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
  const { access_token } = await sessionFor(who);
  const res = await fetch(`${API}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access_token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* HTML error page etc. */
  }
  return { status: res.status, body: parsed as T };
}

// ----------------------------------------------------------------------------- test data

export interface SeededOrder {
  ticketId: string;
  resourceId: string;
  resourceCode: string;
  kitchenLineIds: string[];
  barLineIds: string[];
}

/** Manager opens the cash session if (and only if) it is closed. It is left open: other agents/tests rely on it. */
export async function ensureCashOpen(): Promise<void> {
  const st = await call('manager', 'GET', '/cash/status');
  if (st.status === 200 && st.body.open) return;
  const r = await call('manager', 'POST', '/cash/open', { opening_fund_cents: 0 });
  if (r.status !== 201 && r.status !== 409) throw new Error(`cash/open -> ${r.status}`);
}

/**
 * As waiter: open a ticket on an AVAILABLE regular table (random pick + retry on 409, other agents use the floor
 * too) and add `kitchen` KITCHEN lines and `bar` BAR lines (simple items: no modifiers, no flavour).
 */
export async function seedOrder(opts: { kitchen?: number; bar?: number } = {}): Promise<SeededOrder> {
  const { kitchen = 2, bar = 1 } = opts;
  await ensureCashOpen();
  const items = (await call('waiter', 'GET', '/menu/items')).body as { id: string; name: string; routing: string; requires_flavor: boolean; modifier_groups?: unknown[] }[];
  const simple = (r: string) => items.find((i) => i.routing === r && !i.requires_flavor && !(i.modifier_groups ?? []).length);
  const kItem = simple('KITCHEN');
  const bItem = simple('BAR');
  if (!kItem || !bItem) throw new Error('seed menu has no simple KITCHEN/BAR items');

  const resources = (await call('waiter', 'GET', '/resources')).body as { id: string; code: string; type: string; status: string }[];
  const free = resources.filter((r) => r.type === 'REGULAR_TABLE' && r.status === 'AVAILABLE').sort(() => Math.random() - 0.5);
  let ticket: { id: string } | null = null;
  let table = free[0];
  for (const r of free) {
    const t = await call('waiter', 'POST', '/tickets', { resource_id: r.id, ticket_type: 'TABLE', customer_name: 'contract-test' });
    if (t.status === 201) {
      ticket = t.body;
      table = r;
      break;
    }
  }
  if (!ticket) throw new Error('no AVAILABLE regular table to seed a ticket');

  const lines = async (menuId: string, n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await call('waiter', 'POST', `/tickets/${ticket!.id}/items`, { menu_item_id: menuId, quantity: 1 });
      if (r.status !== 201) throw new Error(`add item -> ${r.status} ${JSON.stringify(r.body)}`);
      ids.push(r.body.id);
    }
    return ids;
  };
  return {
    ticketId: ticket.id,
    resourceId: table.id,
    resourceCode: table.code,
    kitchenLineIds: await lines(kItem.id, kitchen),
    barLineIds: await lines(bItem.id, bar),
  };
}

/** Manager force-close (frees the table, stops timers). Idempotent: 409 TICKET_NOT_OPEN is fine. */
export async function cleanupOrder(o: SeededOrder | null | undefined): Promise<void> {
  if (!o) return;
  await call('manager', 'POST', `/tickets/${o.ticketId}/force-close`, { reason: 'contract test cleanup' });
}
