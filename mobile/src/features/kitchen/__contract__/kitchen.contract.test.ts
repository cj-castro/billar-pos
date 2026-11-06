/**
 * Contract: KDS endpoints against the real local backend (http://localhost:8090, backend extensions B2/B3 deployed).
 * Run with `npm run test:contract`. Logs in once per role (rate limit) and cleans up its ticket.
 */
import { io } from 'socket.io-client';
import { API, BASE, MANAGER_PIN, call, cleanupOrder, seedOrder, sessionFor, type SeededOrder } from '../../../test/contractClient';

let order: SeededOrder;

beforeAll(async () => {
  order = await seedOrder({ kitchen: 3, bar: 2 });
});
afterAll(async () => {
  await cleanupOrder(order);
});

describe('kitchen / bar login', () => {
  it('kitchen user logs in as KITCHEN_STAFF with both tokens', async () => {
    const s = await sessionFor('kitchen');
    expect(s.user.role).toBe('KITCHEN_STAFF');
    expect(typeof s.access_token).toBe('string');
    expect(typeof s.refresh_token).toBe('string');
  });
  it('bar user logs in as BAR_STAFF', async () => {
    expect((await sessionFor('bar')).user.role).toBe('BAR_STAFF');
  });
});

describe('queue shapes', () => {
  it('GET /queue/kitchen: array of lines, oldest first, with the fields the KDS reads', async () => {
    const r = await call('kitchen', 'GET', '/queue/kitchen');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body)).toBe(true);
    const mine = r.body.filter((i: { ticket_id: string }) => i.ticket_id === order.ticketId);
    expect(mine).toHaveLength(3);
    for (const i of mine) {
      expect(i).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          ticket_id: order.ticketId,
          menu_item_name: expect.any(String),
          quantity: 1,
          status: 'SENT',
          routing_dest: 'KITCHEN',
          sent_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          resource_code: order.resourceCode,
          modifiers: expect.any(Array),
        }),
      );
      expect('notes' in i).toBe(true);
    }
    const times = r.body.map((i: { sent_at: string }) => Date.parse(i.sent_at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(r.body.every((i: { status: string }) => ['SENT', 'IN_PROGRESS', 'READY'].includes(i.status))).toBe(true);
  });

  it('GET /queue/bar (as bar staff) lists the BAR lines only', async () => {
    const r = await call('bar', 'GET', '/queue/bar');
    expect(r.status).toBe(200);
    const mine = r.body.filter((i: { ticket_id: string }) => i.ticket_id === order.ticketId);
    expect(mine.map((i: { id: string }) => i.id).sort()).toEqual([...order.barLineIds].sort());
    expect(r.body.every((i: { routing_dest: string }) => i.routing_dest === 'BAR')).toBe(true);
  });

  it('GET /queue/counts is {kitchen, bar} numbers covering the seeded lines', async () => {
    const r = await call('kitchen', 'GET', '/queue/counts');
    expect(r.status).toBe(200);
    expect(r.body.kitchen).toBeGreaterThanOrEqual(3);
    expect(r.body.bar).toBeGreaterThanOrEqual(2);
  });
});

describe('status PATCH', () => {
  it('SENT -> IN_PROGRESS -> READY as kitchen staff, visible in the queue', async () => {
    const id = order.kitchenLineIds[0];
    const a = await call('kitchen', 'PATCH', `/queue/${id}/status`, { status: 'IN_PROGRESS' });
    expect(a).toMatchObject({ status: 200, body: { item_id: id, status: 'IN_PROGRESS' } });
    const b = await call('kitchen', 'PATCH', `/queue/${id}/status`, { status: 'READY' });
    expect(b).toMatchObject({ status: 200, body: { item_id: id, status: 'READY' } });
    const q = await call('kitchen', 'GET', '/queue/kitchen');
    expect(q.body.find((i: { id: string }) => i.id === id).status).toBe('READY');
  });

  it('bar staff advances a BAR line', async () => {
    const id = order.barLineIds[0];
    const r = await call('bar', 'PATCH', `/queue/${id}/status`, { status: 'IN_PROGRESS' });
    expect(r).toMatchObject({ status: 200, body: { status: 'IN_PROGRESS' } });
  });

  it('rejects an unknown status with 422 INVALID_STATUS', async () => {
    const r = await call('kitchen', 'PATCH', `/queue/${order.kitchenLineIds[1]}/status`, { status: 'BANANA' });
    expect(r).toMatchObject({ status: 422, body: { error: 'INVALID_STATUS' } });
  });

  it('NOTE server does not enforce order (client must): SENT -> READY is accepted by the API', async () => {
    const id = order.kitchenLineIds[1];
    const r = await call('kitchen', 'PATCH', `/queue/${id}/status`, { status: 'READY' });
    expect(r.status).toBe(200); // documents why the app enforces single steps itself
  });

  it('a voided line answers 409 ITEM_VOIDED (B3) and is no longer listed', async () => {
    const id = order.kitchenLineIds[2];
    const v = await call('waiter', 'DELETE', `/tickets/${order.ticketId}/items/${id}`, { pin: MANAGER_PIN, reason: 'contract test' });
    expect([200, 204]).toContain(v.status);
    const r = await call('kitchen', 'PATCH', `/queue/${id}/status`, { status: 'IN_PROGRESS' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('ITEM_VOIDED');
    const q = await call('kitchen', 'GET', '/queue/kitchen');
    expect(q.body.some((i: { id: string }) => i.id === id)).toBe(false);
  });

  it('unauthenticated PATCH is 401', async () => {
    const res = await fetch(`${API}/queue/${order.kitchenLineIds[0]}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"status":"SERVED"}' });
    expect(res.status).toBe(401);
  });
});

describe('socket: kitchen room (B2 payload)', () => {
  it('kitchen:item_update carries ticket_id, resource_code, menu_item_name, quantity, opened_by', async () => {
    const id = order.kitchenLineIds[0]; // READY already; SERVED -> emits the event again
    const socket = io(BASE, { path: '/socket.io', transports: ['websocket'], reconnection: false, timeout: 6000 });
    try {
      const payload = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no kitchen:item_update within 8 s')), 8000);
        socket.on('connect_error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        socket.on('kitchen:item_update', (p) => {
          if (p?.item_id === id) {
            clearTimeout(timer);
            resolve(p);
          }
        });
        socket.on('connect', async () => {
          socket.emit('join', { room: 'kitchen' });
          await new Promise((r) => setTimeout(r, 300));
          await call('kitchen', 'PATCH', `/queue/${id}/status`, { status: 'SERVED' });
        });
      });
      expect(payload).toEqual(
        expect.objectContaining({ item_id: id, status: 'SERVED', ticket_id: order.ticketId, resource_code: order.resourceCode, menu_item_name: expect.any(String), quantity: 1, opened_by: expect.any(String) }),
      );
    } finally {
      socket.close();
    }
  });
});
