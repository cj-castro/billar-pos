/**
 * Waiter contract tests against the REAL local backend (docker `billarmobile`, CONTRACT_BASE_URL, default
 * http://localhost:8090). Run: `npm run test:contract`. `npm test` never loads this folder.
 *
 * The app's own API layer (api/client + endpoints) is used for the mobile-facing calls, so wire shapes, headers
 * and error mapping are exercised exactly as the screens use them; raw fetch (contractClient) is used where the
 * HTTP status itself is the assertion (201 vs 200) and for manager/kitchen actors.
 *
 * Login is rate-limited (10/min across everything): tokens come from the shared cache in contractClient.
 */
import { io, type Socket } from 'socket.io-client';
import { ApiError, setAuthBridge } from '../../../api/client';
import { getCashStatus } from '../../../api/endpoints/cash';
import { stockCheck } from '../../../api/endpoints/inventory';
import { listCategories, listItems, listModifiers } from '../../../api/endpoints/menu';
import { getQueue, updateStatus } from '../../../api/endpoints/queue';
import { listResources } from '../../../api/endpoints/resources';
import { addItemIdem, cancelTicket, listPendingPayment, printPreBill, setCustomerName, transferTicket } from '../../../api/endpoints/ticketOps';
import { getTicket, openTicket, requestPayment } from '../../../api/endpoints/tickets';
import { __setServerUrlForTests } from '../../../config/serverConfig';
import type { MenuItem, Resource, Ticket } from '../../../domain/types';
import { API, BASE, call, ensureCashOpen, MANAGER_PIN, sessionFor } from '../../../test/contractClient';
import { deriveCard, deriveFloor } from '../floor/floorState';
import { sendDraft, type LinePatch } from '../draft/sendOrchestrator';
import { newKey } from '../uuid';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: { getItem: jest.fn(async () => null), setItem: jest.fn(async () => {}), removeItem: jest.fn(async () => {}) },
}));
jest.mock('expo-crypto', () => ({ randomUUID: () => (globalThis as { crypto: { randomUUID(): string } }).crypto.randomUUID() }));

const created: string[] = [];
let waiterId = '';
let items: MenuItem[] = [];

const simpleItem = (routing: 'KITCHEN' | 'BAR') => items.find((i) => i.routing === routing && !i.requires_flavor && !(i.modifier_groups ?? []).length && i.is_active)!;

/** Open a ticket on a random AVAILABLE regular table (other agents share the floor: retry on 409). */
async function openOnFreeTable(customer?: string): Promise<{ ticket: Ticket; table: Resource }> {
  const free = (await listResources()).filter((r) => r.type === 'REGULAR_TABLE' && r.status === 'AVAILABLE' && r.is_active).sort(() => Math.random() - 0.5);
  for (const r of free) {
    try {
      const ticket = await openTicket({ resource_id: r.id, ticket_type: 'TABLE', ...(customer ? { customer_name: customer } : {}) });
      created.push(ticket.id);
      return { ticket, table: r };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
    }
  }
  throw new Error('no AVAILABLE regular table');
}

const rawAdd = (ticketId: string, key: string | null, version: number | null, body: object = {}) =>
  call('waiter', 'POST', `/tickets/${ticketId}/items`, body, { ...(key ? { 'Idempotency-Key': key } : {}), ...(version != null ? { 'X-Ticket-Version': String(version) } : {}) });

beforeAll(async () => {
  __setServerUrlForTests(BASE);
  const w = await sessionFor('waiter');
  waiterId = w.user.id;
  setAuthBridge({ getAccessToken: () => w.access_token, getRefreshToken: () => w.refresh_token, setAccessToken: () => {}, onSessionExpired: () => {} });
  await ensureCashOpen();
  items = await listItems();
});

/** Frees the table: cancel an empty ticket, otherwise manager force-close (reason "contract test cleanup"). */
async function release(id: string) {
  const t = await getTicket(id).catch(() => null);
  if (!t || t.status !== 'OPEN') return;
  const ok = await cancelTicket(id).then(() => true).catch(() => false);
  if (!ok) await call('manager', 'POST', `/tickets/${id}/force-close`, { reason: 'contract test cleanup' });
}
const keep = new Set<string>();
// other agents share the floor: give every table back as soon as each test is done
afterEach(async () => {
  for (const id of created.splice(0)) if (!keep.has(id)) await release(id);
});
afterAll(async () => {
  for (const id of keep) await release(id);
});

describe('session', () => {
  it('waiter1 logs in as WAITER with the fields the app stores', async () => {
    const s = await sessionFor('waiter');
    expect(s.user).toEqual(expect.objectContaining({ id: expect.any(String), username: 'waiter1', role: 'WAITER', name: expect.any(String) }));
    expect(s.access_token.split('.')).toHaveLength(3);
    expect(s.refresh_token.split('.')).toHaveLength(3);
  });

  it('a request without a token is a 401 the client maps to ApiError(401)', async () => {
    const res = await fetch(`${API}/resources`);
    expect(res.status).toBe(401);
  });
});

describe('floor endpoints', () => {
  it('GET /resources: shape the floor screen derives from', async () => {
    const rs = await listResources();
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) {
      expect(r).toEqual(expect.objectContaining({ id: expect.any(String), code: expect.any(String), type: expect.stringMatching(/^(BAR_SEAT|POOL_TABLE|REGULAR_TABLE)$/), status: expect.stringMatching(/^(AVAILABLE|IN_USE|INACTIVE)$/), is_active: expect.any(Boolean), sort_order: expect.any(Number) }));
      expect('active_ticket_id' in r).toBe(true);
    }
    expect(new Set(rs.map((r) => r.type)).size).toBeGreaterThanOrEqual(2);
    expect(rs.filter((r) => r.type === 'POOL_TABLE').every((r) => r.pool_config !== undefined)).toBe(true);
  });

  it('GET /tickets/pending-payment and /cash/status', async () => {
    const pending = await listPendingPayment();
    expect(Array.isArray(pending)).toBe(true);
    for (const t of pending) expect(t).toEqual(expect.objectContaining({ id: expect.any(String), payment_requested: true, status: 'OPEN', total_cents: expect.any(Number) }));
    const cash = await getCashStatus();
    expect(cash).toEqual(expect.objectContaining({ open: expect.any(Boolean), open_tickets_count: expect.any(Number) }));
  });

  it('live data derives a sane floor model', async () => {
    const [rs, pending] = await Promise.all([listResources(), listPendingPayment()]);
    const m = deriveFloor(rs, pending);
    expect(m.sections.length).toBeGreaterThan(0);
    for (const s of m.sections) for (const c of s.cards) expect(['FREE', 'OCCUPIED', 'BILL_REQUESTED', 'INACTIVE']).toContain(c.state);
    // every pending ticket's table is shown as a bill, including freed pool tables
    for (const p of pending) {
      const card = m.sections.flatMap((s) => s.cards).find((c) => c.resource.id === p.resource_id);
      if (card && card.resource.is_active && card.resource.status !== 'INACTIVE') expect(card.state).toBe('BILL_REQUESTED');
    }
  });

  it('GET /menu/categories, /menu/items (with embedded modifier groups), /menu/modifiers, /inventory/stock-check', async () => {
    const cats = await listCategories();
    expect(cats[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), routing: expect.stringMatching(/^(KITCHEN|BAR)$/), sort_order: expect.any(Number) }));
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) expect(i).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), price_cents: expect.any(Number), category_id: expect.any(String), requires_flavor: expect.any(Boolean), modifier_groups: expect.any(Array) }));
    const withGroups = items.find((i) => (i.modifier_groups ?? []).length > 0);
    if (withGroups) {
      const g = withGroups.modifier_groups![0];
      expect(g).toEqual(expect.objectContaining({ id: expect.any(String), is_mandatory: expect.any(Boolean), min_selections: expect.any(Number), max_selections: expect.any(Number), allow_multiple: expect.any(Boolean), modifiers: expect.any(Array) }));
      expect(g.modifiers[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), price_cents: expect.any(Number) }));
    }
    const mods = await listModifiers();
    expect(Array.isArray(mods)).toBe(true);
    const stock = await stockCheck();
    expect(stock).toEqual(expect.objectContaining({ blocked_items: expect.any(Array), blocked_modifiers: expect.any(Array) }));
  });
});

describe('open table', () => {
  it('opens a ticket (with customer name); the floor then shows the table OCCUPIED with its active ticket', async () => {
    const { ticket, table } = await openOnFreeTable('contract-waiter');
    expect(ticket).toEqual(expect.objectContaining({ id: expect.any(String), status: 'OPEN', ticket_type: 'TABLE', resource_id: table.id, resource_code: table.code, customer_name: 'contract-waiter', opened_by: waiterId, version: expect.any(Number), total_cents: 0 }));
    const rs = await listResources();
    const card = deriveCard(rs.find((r) => r.id === table.id)!, []);
    expect(card).toMatchObject({ state: 'OCCUPIED', ticketId: ticket.id, customerName: 'contract-waiter' });
  });

  it('opening an occupied table is 409 RESOURCE_OCCUPIED (the screen then refetches and offers the existing ticket)', async () => {
    const { table, ticket } = await openOnFreeTable();
    await expect(openTicket({ resource_id: table.id, ticket_type: 'TABLE' })).rejects.toMatchObject({ status: 409, code: 'RESOURCE_OCCUPIED' });
    const again = (await listResources()).find((r) => r.id === table.id)!;
    expect(again.active_ticket_id).toBe(ticket.id);
  });

  it('unknown resource -> 404, invalid ticket_type -> 422', async () => {
    await expect(openTicket({ resource_id: 'does-not-exist', ticket_type: 'TABLE' })).rejects.toMatchObject({ status: 404 });
    const r = await call('waiter', 'POST', '/tickets', { ticket_type: 'NOPE' });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('INVALID_TICKET_TYPE');
  });

  it('cancelling an empty ticket frees the table; a second cancel is 409; adding to it is 403 TICKET_CLOSED', async () => {
    const { ticket, table } = await openOnFreeTable();
    await cancelTicket(ticket.id);
    expect((await getTicket(ticket.id)).status).toBe('CANCELLED');
    expect((await listResources()).find((r) => r.id === table.id)!.status).toBe('AVAILABLE');
    await expect(cancelTicket(ticket.id)).rejects.toMatchObject({ status: 409, code: 'TICKET_NOT_OPEN' });
    await expect(addItemIdem(ticket.id, { menu_item_id: simpleItem('BAR').id, quantity: 1 }, { idempotencyKey: newKey() })).rejects.toMatchObject({ status: 403, code: 'TICKET_CLOSED' });
  });
});

describe('add item: Idempotency-Key + X-Ticket-Version', () => {
  let ticket: Ticket;
  let version: number;
  const bar = () => simpleItem('BAR');
  const kitchen = () => simpleItem('KITCHEN');

  beforeAll(async () => {
    ticket = (await openOnFreeTable('contract-idem')).ticket;
    keep.add(ticket.id);
    version = ticket.version;
  });

  it('new key -> 201 with the line, client_request_id and ticket_version', async () => {
    const key = newKey();
    const r = await rawAdd(ticket.id, key, version, { menu_item_id: bar().id, quantity: 2 });
    expect(r.status).toBe(201);
    expect(r.body).toEqual(expect.objectContaining({ id: expect.any(String), status: 'SENT', quantity: 2, menu_item_name: bar().name, client_request_id: key, ticket_version: expect.any(Number), routing_dest: 'BAR' }));
    expect(r.body.ticket_version).toBeGreaterThan(version);
    version = r.body.ticket_version;
    (globalThis as { __firstKey?: string; __firstLine?: string }).__firstKey = key;
    (globalThis as { __firstKey?: string; __firstLine?: string }).__firstLine = r.body.id;
  });

  it('replaying the SAME key -> 200, same line, same ticket_version, no second line (even with a stale X-Ticket-Version)', async () => {
    const g = globalThis as { __firstKey?: string; __firstLine?: string };
    const r = await rawAdd(ticket.id, g.__firstKey!, 1, { menu_item_id: bar().id, quantity: 2 });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(g.__firstLine);
    expect(r.body.ticket_version).toBe(version);
    const t = await getTicket(ticket.id);
    expect(t.line_items).toHaveLength(1);
    expect(t.version).toBe(version);
  });

  it('a stale X-Ticket-Version with a NEW key -> 409 VERSION_CONFLICT; nothing was created', async () => {
    const r = await rawAdd(ticket.id, newKey(), version - 1, { menu_item_id: kitchen().id, quantity: 1 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('VERSION_CONFLICT');
    expect((await getTicket(ticket.id)).line_items).toHaveLength(1);
  });

  it('a different key on the same ticket is a new line (201) and bumps the version', async () => {
    const r = await rawAdd(ticket.id, newKey(), version, { menu_item_id: kitchen().id, quantity: 1, notes: 'sin picante' });
    expect(r.status).toBe(201);
    expect(r.body.notes).toBe('sin picante');
    expect(r.body.ticket_version).toBeGreaterThan(version);
    version = r.body.ticket_version;
    expect((await getTicket(ticket.id)).line_items).toHaveLength(2);
  });

  it('invalid keys -> 422 INVALID_IDEMPOTENCY_KEY; invalid quantity -> 422 INVALID_QUANTITY', async () => {
    const bad = await rawAdd(ticket.id, 'bad key!', version, { menu_item_id: bar().id, quantity: 1 });
    expect(bad.status).toBe(422);
    expect(bad.body.error).toBe('INVALID_IDEMPOTENCY_KEY');
    for (const quantity of [0, 100, -1]) {
      const q = await rawAdd(ticket.id, newKey(), version, { menu_item_id: bar().id, quantity });
      expect(q.status).toBe(422);
      expect(q.body.error).toBe('INVALID_QUANTITY');
    }
    expect((await getTicket(ticket.id)).line_items).toHaveLength(2);
  });

  it('FLAVOR_REQUIRED (422) when an item that requires a flavor is sent without a modifier', async () => {
    const flavor = items.find((i) => i.requires_flavor && i.is_active);
    if (!flavor) return; // seed has none: unit-tested client-side rule only
    const r = await rawAdd(ticket.id, newKey(), null, { menu_item_id: flavor.id, quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('FLAVOR_REQUIRED');
  });

  it('OUT_OF_STOCK (422) for an item the stock check blocks', async () => {
    const stock = await stockCheck();
    const blocked = items.find((i) => stock.blocked_items.includes(i.id) && !i.requires_flavor);
    if (!blocked) return; // nothing is out of stock in the seed
    const r = await rawAdd(ticket.id, newKey(), null, { menu_item_id: blocked.id, quantity: 1 });
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('OUT_OF_STOCK');
  });

  it('the send orchestrator against the real API: 2 lines sent once; resending the same keys never duplicates', async () => {
    const t = (await openOnFreeTable('contract-orch')).ticket;
    const lines = [
      { key: newKey(), menuItemId: bar().id, quantity: 1, modifiers: [], notes: '' },
      { key: newKey(), menuItemId: kitchen().id, quantity: 3, modifiers: [], notes: 'bien cocido' },
    ];
    const patches: [string, LinePatch][] = [];
    const deps = { addItem: addItemIdem, fetchVersion: async (id: string) => (await getTicket(id)).version };
    const first = await sendDraft({ ticketId: t.id, lines, version: t.version, deps, onUpdate: (k, p) => patches.push([k, p]) });
    expect(first).toMatchObject({ sent: lines.map((l) => l.key), failed: [], stopped: null });
    let ticketNow = await getTicket(t.id);
    expect(ticketNow.line_items).toHaveLength(2);
    expect(ticketNow.line_items!.map((l) => l.status)).toEqual(['SENT', 'SENT']);

    // simulate "no response received" for line 2: the app retries BOTH with the same keys and a stale version
    const again = await sendDraft({ ticketId: t.id, lines, version: t.version, deps, onUpdate: () => {} });
    expect(again.sent).toEqual(lines.map((l) => l.key));
    ticketNow = await getTicket(t.id);
    expect(ticketNow.line_items).toHaveLength(2); // still two: the server replayed, never duplicated
    expect(ticketNow.line_items!.find((l) => l.quantity === 3)!.notes).toBe('bien cocido');
  });

  it('the orchestrator reports a closed ticket (403 TICKET_CLOSED) as "closed" and keeps the line pending', async () => {
    const t = (await openOnFreeTable()).ticket;
    await cancelTicket(t.id);
    const patches: [string, LinePatch][] = [];
    const key = newKey();
    const r = await sendDraft({
      ticketId: t.id,
      lines: [{ key, menuItemId: bar().id, quantity: 1, modifiers: [], notes: '' }],
      version: 1,
      deps: { addItem: addItemIdem, fetchVersion: async () => null },
      onUpdate: (k, p) => patches.push([k, p]),
    });
    expect(r.stopped).toBe('closed');
    expect(patches.at(-1)).toEqual([key, { state: 'PENDING' }]);
  });
});

describe('ticket lifecycle', () => {
  it('customer name edit and transfer to a free table', async () => {
    const { ticket, table } = await openOnFreeTable('before');
    expect((await setCustomerName(ticket.id, 'after')).customer_name).toBe('after');
    const target = (await listResources()).find((r) => r.type === 'REGULAR_TABLE' && r.status === 'AVAILABLE' && r.id !== table.id);
    if (!target) return;
    const moved = await transferTicket(ticket.id, target.id);
    expect(moved.resource_id).toBe(target.id);
    const rs = await listResources();
    expect(rs.find((r) => r.id === target.id)!.status).toBe('IN_USE');
    expect(rs.find((r) => r.id === table.id)!.status).toBe('AVAILABLE');
    // transferring onto an occupied table is 409
    await expect(transferTicket(ticket.id, target.id)).rejects.toMatchObject({ status: 409 });
  });

  it('request-payment on a ticket with items: ok + total, appears in pending-payment and as BILL_REQUESTED; cancel is refused (HAS_ITEMS)', async () => {
    const { ticket, table } = await openOnFreeTable('contract-bill');
    await addItemIdem(ticket.id, { menu_item_id: simpleItem('BAR').id, quantity: 1 }, { idempotencyKey: newKey() });
    await expect(cancelTicket(ticket.id)).rejects.toMatchObject({ status: 422, code: 'HAS_ITEMS' });
    const r = await requestPayment(ticket.id);
    expect(r).toEqual({ ok: true, total_cents: expect.any(Number) });
    expect(r.total_cents).toBeGreaterThan(0);
    const [rs, pending] = await Promise.all([listResources(), listPendingPayment()]);
    expect(pending.some((p) => p.id === ticket.id)).toBe(true);
    expect(deriveCard(rs.find((x) => x.id === table.id)!, pending).state).toBe('BILL_REQUESTED');
    expect((await getTicket(ticket.id)).payment_requested).toBe(true);
  });

  it('GET /tickets/:id of a missing ticket is a 404 (HTML or JSON, never a crash)', async () => {
    await expect(getTicket('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ status: 404 });
  });

  it('print pre-bill: 200, or a clean 5xx when the print agent is down (the UI maps both)', async () => {
    const { ticket } = await openOnFreeTable();
    const r = await printPreBill(ticket.id).then(
      () => 200,
      (e: ApiError) => e.status,
    );
    expect([200, 500, 503]).toContain(r);
  });
});

describe('manager-gated actions (P1)', () => {
  it('void needs a manager PIN: wrong -> 401 INVALID_PIN, right -> 200; the voided line can no longer change status (B3)', async () => {
    const { ticket } = await openOnFreeTable();
    const added = await addItemIdem(ticket.id, { menu_item_id: simpleItem('KITCHEN').id, quantity: 1 }, { idempotencyKey: newKey() });
    const wrong = await call('waiter', 'DELETE', `/tickets/${ticket.id}/items/${added.id}`, { pin: '0000', reason: 'contract' });
    expect([401, 403]).toContain(wrong.status);
    const ok = await call('waiter', 'DELETE', `/tickets/${ticket.id}/items/${added.id}`, { pin: MANAGER_PIN, reason: 'contract' });
    expect(ok.status).toBe(200);
    expect((await getTicket(ticket.id)).line_items![0].status).toBe('VOIDED');
    await expect(updateStatus(added.id, 'READY')).rejects.toMatchObject({ status: 409, code: 'ITEM_VOIDED' });
  });

  it('quantity: increase is free, decrease needs a PIN (403 MANAGER_REQUIRED without it)', async () => {
    const { ticket } = await openOnFreeTable();
    const line = await addItemIdem(ticket.id, { menu_item_id: simpleItem('BAR').id, quantity: 2 }, { idempotencyKey: newKey() });
    const up = await call('waiter', 'PATCH', `/tickets/${ticket.id}/items/${line.id}`, { quantity: 3 });
    expect(up.status).toBe(200);
    const down = await call('waiter', 'PATCH', `/tickets/${ticket.id}/items/${line.id}`, { quantity: 1 });
    expect(down.status).toBe(403);
    expect(down.body.error).toBe('MANAGER_REQUIRED');
    const withPin = await call('waiter', 'PATCH', `/tickets/${ticket.id}/items/${line.id}`, { quantity: 1, pin: MANAGER_PIN });
    expect(withPin.status).toBe(200);
  });

  it('discount is manager-only: waiter 403, manager 200; /auth/verify-pin accepts the manager PIN', async () => {
    const { ticket } = await openOnFreeTable();
    await addItemIdem(ticket.id, { menu_item_id: simpleItem('BAR').id, quantity: 1 }, { idempotencyKey: newKey() });
    expect((await call('waiter', 'PATCH', `/tickets/${ticket.id}/discount`, { pct: 10 })).status).toBe(403);
    const v = await call('manager', 'POST', '/auth/verify-pin', { pin: MANAGER_PIN });
    expect(v.status).toBe(200);
    expect(v.body).toEqual(expect.objectContaining({ valid: true, manager_name: expect.any(String) }));
    const d = await call('manager', 'PATCH', `/tickets/${ticket.id}/discount`, { pct: 10, reason: 'contract' });
    expect(d.status).toBe(200);
    expect((await getTicket(ticket.id)).discount_cents).toBeGreaterThan(0);
  });
});

describe('ready flow (kitchen -> waiter) and realtime payload (B2)', () => {
  it('READY event carries ticket_id/resource_code/menu_item_name; Listos data shows it; waiter marks it SERVED', async () => {
    const { ticket, table } = await openOnFreeTable('contract-ready');
    const line = await addItemIdem(ticket.id, { menu_item_id: simpleItem('KITCHEN').id, quantity: 1 }, { idempotencyKey: newKey() });
    expect(line.routing_dest).toBe('KITCHEN');

    // the waiter app joins the public kitchen room (WAITER gets no queue room from roomsForRole)
    const socket: Socket = io(BASE, { path: '/socket.io', transports: ['websocket', 'polling'], reconnection: false });
    try {
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error('socket join timeout')), 8000);
        socket.on('connect', () => socket.emit('join', { room: 'kitchen' }));
        socket.on('joined', (p: { room: string }) => {
          if (p.room === 'kitchen') {
            clearTimeout(t);
            res();
          }
        });
        socket.on('connect_error', (e) => rej(e));
      });
      const readyEvent = new Promise<Record<string, unknown>>((res, rej) => {
        const t = setTimeout(() => rej(new Error('no READY event')), 8000);
        socket.on('kitchen:item_update', (p: Record<string, unknown>) => {
          if (p.item_id === line.id && p.status === 'READY') {
            clearTimeout(t);
            res(p);
          }
        });
      });
      expect((await call('kitchen', 'PATCH', `/queue/${line.id}/status`, { status: 'IN_PROGRESS' })).status).toBe(200);
      expect((await call('kitchen', 'PATCH', `/queue/${line.id}/status`, { status: 'READY' })).status).toBe(200);
      const p = await readyEvent;
      expect(p).toEqual(expect.objectContaining({ item_id: line.id, status: 'READY', ticket_id: ticket.id, resource_code: table.code, menu_item_name: line.menu_item_name, quantity: 1}));
      expect(p).not.toHaveProperty('opened_by');
    } finally {
      socket.close();
    }

    const queue = await getQueue('KITCHEN');
    const row = queue.find((q) => q.id === line.id);
    expect(row).toEqual(expect.objectContaining({ status: 'READY', resource_code: table.code, ticket_id: ticket.id }));

    const served = await updateStatus(line.id, 'SERVED');
    expect(served).toEqual({ item_id: line.id, status: 'SERVED' });
    expect((await getTicket(ticket.id)).line_items![0].status).toBe('SERVED');
    expect((await getQueue('KITCHEN')).some((q) => q.id === line.id)).toBe(false);
  });
});
