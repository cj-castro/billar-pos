import type { Resource, Ticket } from '../../../domain/types';
import { deriveCard, deriveFloor } from '../floor/floorState';

const res = (over: Partial<Resource>): Resource => ({
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
const tk = (over: Partial<Ticket>): Ticket =>
  ({ id: 'tk1', resource_id: 'r1', resource_code: 'T1', status: 'OPEN', payment_requested: true, payment_requested_at: '2026-01-01T10:00:00+00:00', total_cents: 5000, customer_name: null, ...over }) as Ticket;

describe('deriveCard', () => {
  it('FREE / OCCUPIED / INACTIVE from resource status', () => {
    expect(deriveCard(res({}), []).state).toBe('FREE');
    expect(deriveCard(res({ status: 'IN_USE', active_ticket_id: 'tk9' }), [])).toMatchObject({ state: 'OCCUPIED', ticketId: 'tk9' });
    expect(deriveCard(res({ status: 'INACTIVE' }), []).state).toBe('INACTIVE');
    expect(deriveCard(res({ is_active: false }), []).state).toBe('INACTIVE');
  });

  it('BILL_REQUESTED when a pending-payment ticket matches the resource id', () => {
    const c = deriveCard(res({ status: 'IN_USE', active_ticket_id: 'tk1' }), [tk({})]);
    expect(c).toMatchObject({ state: 'BILL_REQUESTED', ticketId: 'tk1' });
  });

  it('matches by active_ticket_id even if resource_id differs', () => {
    const c = deriveCard(res({ id: 'rX', status: 'IN_USE', active_ticket_id: 'tk1' }), [tk({ resource_id: 'other' })]);
    expect(c.state).toBe('BILL_REQUESTED');
  });

  it('pool table AVAILABLE after request-payment (ticket still OPEN) is BILL_REQUESTED, not FREE, and its timer is hidden', () => {
    const pool = res({ id: 'bt1', code: 'BT1', type: 'POOL_TABLE', status: 'AVAILABLE', active_ticket_id: 'tk7', timer_start: '2026-01-01T09:00:00+00:00' });
    const c = deriveCard(pool, [tk({ id: 'tk7', resource_id: 'bt1', resource_code: 'BT1' })]);
    expect(c).toMatchObject({ state: 'BILL_REQUESTED', ticketId: 'tk7', timerStart: null });
  });

  it('even without active_ticket_id the pending ticket keeps the pool table from showing as FREE', () => {
    const pool = res({ id: 'bt1', type: 'POOL_TABLE', status: 'AVAILABLE' });
    expect(deriveCard(pool, [tk({ id: 'tk7', resource_id: 'bt1' })]).state).toBe('BILL_REQUESTED');
  });

  it('running pool timer only while OCCUPIED', () => {
    const pool = res({ type: 'POOL_TABLE', status: 'IN_USE', active_ticket_id: 'tk2', timer_start: '2026-01-01T09:00:00+00:00' });
    expect(deriveCard(pool, []).timerStart).toBe('2026-01-01T09:00:00+00:00');
    expect(deriveCard(res({ status: 'IN_USE', active_ticket_id: 'tk2', timer_start: 'x' }), []).timerStart).toBeNull(); // not a pool
  });

  it('customer name comes from the bill ticket or the resource', () => {
    expect(deriveCard(res({ status: 'IN_USE', customer_name: 'Ana' }), []).customerName).toBe('Ana');
  });
});

describe('deriveFloor', () => {
  it('groups Billar / Mesas / Barra in that order, natural-sorted by sort_order then code, hides empty groups', () => {
    const m = deriveFloor(
      [
        res({ id: 'b10', code: 'B10', type: 'BAR_SEAT', sort_order: 1 }),
        res({ id: 'bt10', code: 'BT10', type: 'POOL_TABLE', sort_order: 1 }),
        res({ id: 'bt2', code: 'BT2', type: 'POOL_TABLE', sort_order: 1 }),
        res({ id: 't1', code: 'T1', sort_order: 0 }),
        res({ id: 'b2', code: 'B2', type: 'BAR_SEAT', sort_order: 1 }),
      ],
      [],
    );
    expect(m.sections.map((s) => s.kind)).toEqual(['POOL', 'TABLE', 'BAR']);
    expect(m.sections[0].cards.map((c) => c.resource.code)).toEqual(['BT2', 'BT10']);
    expect(m.sections[2].cards.map((c) => c.resource.code)).toEqual(['B2', 'B10']);
    expect(deriveFloor([res({ type: 'BAR_SEAT' })], []).sections.map((s) => s.kind)).toEqual(['BAR']);
  });

  it('counts occupied / bills per section and lists every pending ticket newest first', () => {
    const resources = [
      res({ id: 'a', code: 'T1', status: 'IN_USE', active_ticket_id: 'ta' }),
      res({ id: 'b', code: 'T2', status: 'IN_USE', active_ticket_id: 'tb' }),
      res({ id: 'c', code: 'T3' }),
    ];
    const pending = [tk({ id: 'tb', resource_id: 'b', payment_requested_at: '2026-01-01T10:00:00+00:00' }), tk({ id: 'tx', resource_id: null, resource_code: null, payment_requested_at: '2026-01-01T11:00:00+00:00' })];
    const m = deriveFloor(resources, pending);
    expect(m.sections[0]).toMatchObject({ occupied: 1, bills: 1 });
    expect(m.pendingBills.map((t) => t.id)).toEqual(['tx', 'tb']);
  });

  it('empty resource list gives no sections', () => {
    expect(deriveFloor([], []).sections).toEqual([]);
  });
});
