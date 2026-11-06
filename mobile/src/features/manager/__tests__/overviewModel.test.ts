import type { OpenTicketRow } from '../../../api/endpoints/managerTickets';
import type { CashStatus, Resource } from '../../../domain/types';
import { qi } from '../../kitchen/testFixtures';
import { floorTiles } from '../floorModel';
import { aggregateOverview, deriveAlerts, oldestWaiting } from '../overviewModel';
import { parsePrintFailed, usePrintFailures } from '../printFailures';
import { managerTabVisibility } from '../tabs';
import { filterTickets } from '../ticketsModel';

const NOW = new Date('2026-11-05T21:00:00+00:00').getTime();
const minAgo = (m: number) => new Date(NOW - m * 60000).toISOString();

const cash = (over: Partial<CashStatus> = {}): CashStatus => ({
  open: true,
  session: {
    id: 's1',
    date: '2026-11-05',
    status: 'OPEN',
    opening_fund_cents: 50000,
    closing_cash_counted_cents: null,
    opened_by: 'u',
    closed_by: null,
    opened_at: '2026-11-05T14:00:00+00:00',
    closed_at: null,
    notes: null,
  },
  open_tickets_count: 3,
  ghost_tickets_count: 0,
  ...over,
});
const row = (id: string, total: number, over: Partial<OpenTicketRow> = {}): OpenTicketRow => ({
  id,
  resource_code: id.toUpperCase(),
  resource_status: 'IN_USE',
  customer_name: null,
  opened_at: '2026-11-05T19:00:00+00:00',
  item_count: 2,
  total_cents: total,
  ...over,
});

describe('aggregateOverview', () => {
  it('combines every source', () => {
    const s = aggregateOverview({
      cash: cash(),
      openAll: [row('m1', 10000), row('m2', 25050)],
      pending: [{ id: 'm1' }],
      counts: { kitchen: 4, bar: 2 },
      kitchenQueue: [qi({ id: 'a', sent_at: minAgo(12) })],
      barQueue: [qi({ id: 'b', status: 'IN_PROGRESS', sent_at: minAgo(30) })],
    });
    expect(s).toMatchObject({
      cashOpen: true,
      fundCents: 50000,
      openTickets: 2,
      openTotalCents: 35050,
      billRequested: 1,
      kitchenCount: 4,
      barCount: 2,
      ghost: 0,
    });
    expect(new Date(s.oldestSentAt!).getTime()).toBe(NOW - 30 * 60000);
  });

  it('a failed endpoint is null ("-"), never a fake 0; open-all falls back to the cash counter for the count only', () => {
    const s = aggregateOverview({ cash: cash({ open_tickets_count: 5 }) });
    expect(s.openTickets).toBe(5);
    expect(s.openTotalCents).toBeNull();
    expect(s.billRequested).toBeNull();
    expect(s.kitchenCount).toBeNull();
    expect(s.oldestSentAt).toBeNull();
    const none = aggregateOverview({});
    expect(none).toMatchObject({ cashOpen: null, openTickets: null, ghost: null, fundCents: null });
  });

  it('closed cash', () => {
    const s = aggregateOverview({ cash: { open: false, session: null, open_tickets_count: 0, ghost_tickets_count: 0 } });
    expect(s.cashOpen).toBe(false);
    expect(s.fundCents).toBeNull();
  });

  it('oldest item ignores READY (it waits for the waiter, not the cook)', () => {
    expect(oldestWaiting([qi({ id: 'r', status: 'READY', sent_at: minAgo(90) }), qi({ id: 's', sent_at: minAgo(5) })])).toBe(minAgo(5));
    expect(oldestWaiting([], undefined)).toBeNull();
  });
});

describe('deriveAlerts', () => {
  const base = { cash: cash() };
  it('no alerts when all is calm', () => {
    const inp = { ...base, kitchenQueue: [qi({ id: 'a', sent_at: minAgo(3) })] };
    expect(deriveAlerts(aggregateOverview(inp), inp, NOW)).toEqual([]);
  });

  it('cash closed', () => {
    const inp = { cash: { open: false, session: null, open_tickets_count: 0, ghost_tickets_count: 0 } };
    expect(deriveAlerts(aggregateOverview(inp), inp, NOW).map((a) => a.kind)).toEqual(['cash_closed']);
  });

  it('items older than 20 min (strictly), only SENT/IN_PROGRESS, both stations', () => {
    const inp = {
      ...base,
      kitchenQueue: [
        qi({ id: 'a', sent_at: minAgo(20) }), // exactly 20: not yet
        qi({ id: 'b', sent_at: minAgo(21) }),
        qi({ id: 'c', status: 'READY', sent_at: minAgo(60) }), // READY ignored
      ],
      barQueue: [qi({ id: 'd', status: 'IN_PROGRESS', sent_at: minAgo(35) })],
    };
    const alerts = deriveAlerts(aggregateOverview(inp), inp, NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: 'old_items', severity: 'alert', count: 2, minutes: 35 });
  });

  it('ghost tickets and print failures (each failure its own dismissible alert)', () => {
    const inp = {
      cash: cash({ ghost_tickets_count: 2 }),
      printFailures: [{ id: 'j1', type: 'CHIT', error: 'agent down', ticketId: null, at: NOW }],
    };
    const alerts = deriveAlerts(aggregateOverview(inp), inp, NOW);
    expect(alerts.map((a) => a.kind)).toEqual(['ghost', 'print_failed']);
    expect(alerts[0].count).toBe(2);
    expect(alerts[1]).toMatchObject({ failureId: 'j1', detail: 'agent down' });
  });
});

describe('print:failed socket payloads', () => {
  it('parses chit and ticket payloads, tolerates garbage', () => {
    expect(parsePrintFailed({ job_id: 'j', queue_item_id: 'q', type: 'CHIT', error: 'x' }, 1)).toEqual({ id: 'j', type: 'CHIT', error: 'x', ticketId: null, at: 1 });
    expect(parsePrintFailed({ ticket_id: 't9', job_id: 'j2' }, 1)).toMatchObject({ id: 'j2', ticketId: 't9' });
    expect(parsePrintFailed(undefined, 7).id).toBe('pf-7');
  });
  it('store dedupes by id, caps at 20, dismisses', () => {
    const { add, dismiss, clear } = usePrintFailures.getState();
    clear();
    add({ id: 'a', type: null, error: null, ticketId: null, at: 1 });
    add({ id: 'a', type: null, error: 'again', ticketId: null, at: 2 });
    expect(usePrintFailures.getState().items).toHaveLength(1);
    for (let i = 0; i < 30; i++) add({ id: `x${i}`, type: null, error: null, ticketId: null, at: i });
    expect(usePrintFailures.getState().items).toHaveLength(20);
    dismiss('x29');
    expect(usePrintFailures.getState().items[0].id).toBe('x28');
    clear();
  });
});

describe('filterTickets', () => {
  const rows = [row('m2', 1, { opened_at: '2026-11-05T20:00:00+00:00' }), row('m1', 1, { opened_at: '2026-11-05T19:00:00+00:00' })];
  it('all: oldest first', () => expect(filterTickets(rows, new Set(), 'all').map((r) => r.id)).toEqual(['m1', 'm2']));
  it('bills: only tickets with cuenta solicitada', () => expect(filterTickets(rows, new Set(['m2']), 'bills').map((r) => r.id)).toEqual(['m2']));
});

describe('floorTiles', () => {
  const res = (over: Partial<Resource> & { id: string; code: string }): Resource => ({
    name: over.code,
    type: 'REGULAR_TABLE',
    status: 'AVAILABLE',
    is_active: true,
    is_temp: false,
    sort_order: 0,
    ...over,
  });
  it('maps type/state; pending payment wins; inactive stays inactive; sorted', () => {
    const tiles = floorTiles(
      [
        res({ id: 'r3', code: 'B1', type: 'BAR_SEAT', sort_order: 3 }),
        res({ id: 'r2', code: 'P1', type: 'POOL_TABLE', status: 'AVAILABLE', sort_order: 1 }),
        res({ id: 'r1', code: 'M1', status: 'IN_USE', active_ticket_id: 't1', sort_order: 2 }),
        res({ id: 'r4', code: 'X', status: 'INACTIVE', is_active: false, sort_order: 4 }),
      ],
      [{ id: 'tp', resource_id: 'r2' }],
    );
    expect(tiles.map((t) => [t.code, t.kind, t.state])).toEqual([
      ['P1', 'POOL', 'BILL_REQUESTED'], // pool tables are freed by request-payment: the pending list is the only signal
      ['M1', 'TABLE', 'OCCUPIED'],
      ['B1', 'BAR', 'FREE'],
      ['X', 'TABLE', 'INACTIVE'],
    ]);
    expect(tiles[1].ticketId).toBe('t1');
  });
});

describe('managerTabVisibility', () => {
  it('system tab is ADMIN only, kds tab MANAGER only', () => {
    expect(managerTabVisibility('ADMIN')).toEqual({ kds: false, system: true });
    expect(managerTabVisibility('MANAGER')).toEqual({ kds: true, system: false });
    for (const r of ['WAITER', 'KITCHEN_STAFF', 'BAR_STAFF', undefined, null]) expect(managerTabVisibility(r).system).toBe(false);
  });
});
