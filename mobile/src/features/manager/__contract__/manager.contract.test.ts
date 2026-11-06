/**
 * Contract: manager/admin endpoints, settings round-trip and role boundaries against the real local backend.
 * Run with `npm run test:contract`.
 */
import { call, cleanupOrder, seedOrder, sessionFor, type SeededOrder } from '../../../test/contractClient';

let order: SeededOrder;

beforeAll(async () => {
  order = await seedOrder({ kitchen: 1, bar: 1 });
});
afterAll(async () => {
  await cleanupOrder(order);
});

describe('logins', () => {
  it('manager and admin roles', async () => {
    expect((await sessionFor('manager')).user.role).toBe('MANAGER');
    expect((await sessionFor('admin')).user.role).toBe('ADMIN');
  });
});

describe('overview endpoints', () => {
  it('GET /health -> {status:"ok"} without auth', async () => {
    const res = await fetch(`${process.env.CONTRACT_BASE_URL ?? 'http://localhost:8090'}/api/v1/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });

  it('GET /cash/status: open flag, session, open + ghost counters', async () => {
    const r = await call('manager', 'GET', '/cash/status');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.objectContaining({ open: true, open_tickets_count: expect.any(Number), ghost_tickets_count: expect.any(Number) }));
    expect(r.body.session).toEqual(expect.objectContaining({ id: expect.any(String), status: 'OPEN', opening_fund_cents: expect.any(Number), opened_at: expect.stringMatching(/^\d{4}-/) }));
    expect(r.body.open_tickets_count).toBeGreaterThanOrEqual(1);
  });

  it('GET /tickets/open-all: manager rows include the seeded ticket', async () => {
    const r = await call('manager', 'GET', '/tickets/open-all');
    expect(r.status).toBe(200);
    const row = r.body.find((t: { id: string }) => t.id === order.ticketId);
    expect(row).toEqual({
      id: order.ticketId,
      resource_code: order.resourceCode,
      resource_status: 'IN_USE',
      customer_name: 'contract-test',
      opened_at: expect.any(String),
      item_count: 2,
      total_cents: expect.any(Number),
    });
    // oldest first
    const times = r.body.map((t: { opened_at: string }) => Date.parse(t.opened_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('admin can read open-all too', async () => {
    expect((await call('admin', 'GET', '/tickets/open-all')).status).toBe(200);
  });

  it('GET /tickets/pending-payment lists a ticket once the bill is requested', async () => {
    const before = await call('manager', 'GET', '/tickets/pending-payment');
    expect(before.status).toBe(200);
    expect(before.body.some((t: { id: string }) => t.id === order.ticketId)).toBe(false);
    const req = await call('waiter', 'POST', `/tickets/${order.ticketId}/request-payment`);
    expect(req.status).toBe(200);
    const after = await call('manager', 'GET', '/tickets/pending-payment');
    const t = after.body.find((x: { id: string }) => x.id === order.ticketId);
    expect(t).toEqual(expect.objectContaining({ payment_requested: true, resource_id: order.resourceId, status: 'OPEN' }));
  });

  it('GET /tickets/:id detail (read-only manager view) has line_items and server totals', async () => {
    const r = await call('manager', 'GET', `/tickets/${order.ticketId}`);
    expect(r.status).toBe(200);
    expect(r.body.line_items).toHaveLength(2);
    expect(r.body).toEqual(expect.objectContaining({ total_cents: expect.any(Number), version: expect.any(Number), resource_code: order.resourceCode }));
    expect(r.body.line_items[0]).toEqual(expect.objectContaining({ menu_item_name: expect.any(String), status: 'SENT', net_cents: expect.any(Number), modifiers: expect.any(Array) }));
  });

  it('GET /queue/counts and /queue/{kitchen,bar} are readable by the manager', async () => {
    const c = await call('manager', 'GET', '/queue/counts');
    expect(c.body).toEqual({ kitchen: expect.any(Number), bar: expect.any(Number) });
    expect((await call('manager', 'GET', '/queue/kitchen')).status).toBe(200);
    expect((await call('manager', 'GET', '/queue/bar')).status).toBe(200);
  });

  it('GET /resources (floor view): typed resources with status', async () => {
    const r = await call('manager', 'GET', '/resources');
    expect(r.status).toBe(200);
    const mine = r.body.find((x: { id: string }) => x.id === order.resourceId);
    expect(mine).toEqual(expect.objectContaining({ code: order.resourceCode, type: 'REGULAR_TABLE', status: 'IN_USE', is_active: true, sort_order: expect.any(Number) }));
  });
});

describe('settings round trip (original values restored)', () => {
  for (const key of ['kds_sound_enabled', 'print_bar_tickets']) {
    it(`${key}: GET -> PUT flipped -> GET -> restore`, async () => {
      const orig = await call('manager', 'GET', `/settings/${key}`);
      expect(orig.status).toBe(200);
      expect(orig.body.key).toBe(key);
      expect(['true', 'false']).toContain(orig.body.value);
      const flipped = orig.body.value === 'true' ? 'false' : 'true';
      try {
        const put = await call('manager', 'PUT', `/settings/${key}`, { value: flipped });
        expect(put).toMatchObject({ status: 200, body: { key, value: flipped } });
        expect((await call('admin', 'GET', `/settings/${key}`)).body.value).toBe(flipped);
      } finally {
        const back = await call('manager', 'PUT', `/settings/${key}`, { value: orig.body.value });
        expect(back.body.value).toBe(orig.body.value);
      }
      expect((await call('manager', 'GET', `/settings/${key}`)).body.value).toBe(orig.body.value);
    });
  }

  it('admin may also PUT (and restore)', async () => {
    const orig = (await call('admin', 'GET', '/settings/kds_sound_enabled')).body.value;
    const r = await call('admin', 'PUT', '/settings/kds_sound_enabled', { value: orig });
    expect(r).toMatchObject({ status: 200, body: { value: orig } });
  });
});

describe('role boundaries', () => {
  it('waiter cannot apply a discount: PATCH /tickets/:id/discount -> 403', async () => {
    const r = await call('waiter', 'PATCH', `/tickets/${order.ticketId}/discount`, { pct: 10 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe('FORBIDDEN');
    const t = await call('manager', 'GET', `/tickets/${order.ticketId}`);
    expect(t.body.manual_discount_pct ?? 0).toBe(0); // nothing was applied
  });

  it('waiter, kitchen and bar cannot list open-all or force-close', async () => {
    for (const who of ['waiter', 'kitchen', 'bar'] as const) {
      expect((await call(who, 'GET', '/tickets/open-all')).status).toBe(403);
      expect((await call(who, 'POST', `/tickets/${order.ticketId}/force-close`, { reason: 'nope' })).status).toBe(403);
    }
  });

  it('waiter and kitchen cannot PUT settings (403 Forbidden); value unchanged', async () => {
    const orig = (await call('manager', 'GET', '/settings/print_bar_tickets')).body.value;
    for (const who of ['waiter', 'kitchen'] as const) {
      const r = await call(who, 'PUT', '/settings/print_bar_tickets', { value: orig === 'true' ? 'false' : 'true' });
      expect(r.status).toBe(403);
    }
    expect((await call('manager', 'GET', '/settings/print_bar_tickets')).body.value).toBe(orig);
  });

  it('waiter can still read settings (KDS sound flag is public to staff)', async () => {
    expect((await call('waiter', 'GET', '/settings/kds_sound_enabled')).status).toBe(200);
  });

  it('every protected endpoint rejects a missing token (401)', async () => {
    const base = process.env.CONTRACT_BASE_URL ?? 'http://localhost:8090';
    for (const p of ['/cash/status', '/tickets/open-all', '/queue/counts', '/resources']) {
      expect((await fetch(`${base}/api/v1${p}`)).status).toBe(401);
    }
  });
});
