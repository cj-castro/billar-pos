import type { MenuItem, ModifierGroup, QueueItem, Ticket } from '../../../domain/types';
import { buildDraftLine, checkSelections, needsConfigurator, NOTE_MAX } from '../configure/configurator';
import { ALL_CATEGORIES, filterMenuItems, normalizeText } from '../menu/menuSearch';
import { buildReadyModel, classifyReadyEvent } from '../ready/readyEvents';
import { activeTimerStart, canCancelTable, canRequestBill } from '../ticket/ticketRules';

const item = (over: Partial<MenuItem>): MenuItem => ({ id: 'i', category_id: 'c1', name: 'X', price_cents: 1000, requires_flavor: false, is_active: true, sort_order: 0, routing: 'BAR', ...over });

describe('menu search', () => {
  it('normalizes case and accents', () => {
    expect(normalizeText('  Piña  COLADA ')).toBe('pina colada');
    expect(normalizeText('Jalapeño Ñandú')).toBe('jalapeno nandu');
  });

  const items = [item({ id: '1', name: 'Piña Colada' }), item({ id: '2', name: 'Cerveza Corona', category_id: 'c2' }), item({ id: '3', name: 'Margarita de limón' }), item({ id: '4', name: 'Oculta', is_active: false })];
  it('matches without accents / case, every word must match, ignores inactive', () => {
    expect(filterMenuItems(items, ALL_CATEGORIES, 'pina').map((i) => i.id)).toEqual(['1']);
    expect(filterMenuItems(items, ALL_CATEGORIES, 'LIMON').map((i) => i.id)).toEqual(['3']);
    expect(filterMenuItems(items, ALL_CATEGORIES, 'cer cor').map((i) => i.id)).toEqual(['2']);
    expect(filterMenuItems(items, ALL_CATEGORIES, 'oculta')).toEqual([]);
    expect(filterMenuItems(items, ALL_CATEGORIES, '')).toHaveLength(3);
  });
  it('filters by category and query together', () => {
    expect(filterMenuItems(items, 'c2', '').map((i) => i.id)).toEqual(['2']);
    expect(filterMenuItems(items, 'c2', 'pina')).toEqual([]);
  });
});

describe('configurator rules', () => {
  const group = (over: Partial<ModifierGroup>): ModifierGroup => ({
    id: 'g1',
    name: 'Salsa',
    is_mandatory: true,
    min_selections: 1,
    max_selections: 1,
    allow_multiple: false,
    modifiers: [
      { id: 'm1', name: 'BBQ', price_cents: 0, modifier_group_id: 'g1', is_active: true },
      { id: 'm2', name: 'Búfalo', price_cents: 500, modifier_group_id: 'g1', is_active: true },
    ],
    ...over,
  });

  it('mandatory single group blocks until one is picked', () => {
    const g = [group({})];
    expect(checkSelections(g, {})).toEqual({ valid: false, invalidGroupIds: ['g1'] });
    expect(checkSelections(g, { g1: ['m1'] }).valid).toBe(true);
  });
  it('multi group enforces min and max', () => {
    const g = [group({ allow_multiple: true, min_selections: 2, max_selections: 3 })];
    expect(checkSelections(g, { g1: ['m1'] }).valid).toBe(false);
    expect(checkSelections(g, { g1: ['m1', 'm2'] }).valid).toBe(true);
    expect(checkSelections(g, { g1: ['m1', 'm2', 'x', 'y'] }).valid).toBe(false);
  });
  it('optional group never blocks', () => {
    expect(checkSelections([group({ is_mandatory: false })], {}).valid).toBe(true);
  });
  it('builds the draft line with modifier names/prices, trimmed capped note', () => {
    const it = item({ id: 'w', name: 'Alitas', price_cents: 14500 });
    const l = buildDraftLine(it, [group({})], { g1: ['m2'] }, `  ${'a'.repeat(300)}  `, 2);
    expect(l).toMatchObject({ menuItemId: 'w', name: 'Alitas', unitPriceCents: 14500, quantity: 2, modifiers: [{ id: 'm2', name: 'Búfalo', priceCents: 500 }] });
    expect(l.notes).toHaveLength(NOTE_MAX);
  });
  it('quick-add only for items without options', () => {
    expect(needsConfigurator(item({}))).toBe(false);
    expect(needsConfigurator(item({ modifier_groups: [group({})] }))).toBe(true);
    expect(needsConfigurator(item({ requires_flavor: true }))).toBe(true);
  });
});

describe('classifyReadyEvent', () => {
  const ev = { item_id: 'a', status: 'READY', ticket_id: 't1', resource_code: 'T4', menu_item_name: 'Alitas BBQ', quantity: 1 };
  const mine = new Set(['t1']);
  it('notifies for READY on my ticket', () => {
    const seen = new Set<string>();
    expect(classifyReadyEvent(ev, mine, seen)).toEqual({ action: 'notify', ticketId: 't1', name: 'Alitas BBQ', code: 'T4', itemId: 'a' });
  });
  it('ignores other waiters, other statuses, and junk', () => {
    expect(classifyReadyEvent(ev, new Set(['t9']), new Set())).toEqual({ action: 'ignore' });
    expect(classifyReadyEvent({ ...ev, status: 'IN_PROGRESS' }, mine, new Set())).toEqual({ action: 'ignore' });
    expect(classifyReadyEvent(undefined, mine, new Set())).toEqual({ action: 'ignore' });
    expect(classifyReadyEvent({ status: 'READY' }, mine, new Set())).toEqual({ action: 'ignore' });
    expect(classifyReadyEvent(ev, null, new Set())).toEqual({ action: 'refetch' }); // my tickets not loaded yet
  });
  it('falls back to a refetch when B2 fields are missing', () => {
    expect(classifyReadyEvent({ item_id: 'a', status: 'READY' }, mine, new Set())).toEqual({ action: 'refetch' });
  });
  it('dedupes the same item+status', () => {
    const seen = new Set<string>();
    expect(classifyReadyEvent(ev, mine, seen).action).toBe('notify');
    expect(classifyReadyEvent(ev, mine, seen).action).toBe('ignore');
  });
  it('null resource_code is tolerated (express tickets)', () => {
    expect(classifyReadyEvent({ ...ev, resource_code: null }, mine, new Set())).toMatchObject({ action: 'notify', code: '' });
  });
});

describe('buildReadyModel', () => {
  const q = (id: string, ticket: string, status: string, sent: string, code = 'T1'): QueueItem => ({ id, ticket_id: ticket, status, sent_at: sent, resource_code: code, menu_item_name: id, quantity: 1, modifiers: [] }) as unknown as QueueItem;
  const tk = (id: string, by: string, name: string | null = null) => ({ id, opened_by: by, customer_name: name, resource_code: 'T1' }) as Ticket;

  it('keeps only READY, groups by ticket oldest first, mine before others, counts mine', () => {
    const m = buildReadyModel(
      [q('x1', 'tA', 'READY', '2026-01-01T10:05:00'), q('x2', 'tA', 'READY', '2026-01-01T10:01:00'), q('x3', 'tB', 'READY', '2026-01-01T10:00:00', 'T2'), q('x4', 'tA', 'IN_PROGRESS', '2026-01-01T10:00:00')],
      [tk('tA', 'me', 'Ana'), tk('tB', 'other')],
      'me',
    );
    expect(m.mine.map((g) => g.ticketId)).toEqual(['tA']);
    expect(m.mine[0].items.map((i) => i.id)).toEqual(['x2', 'x1']);
    expect(m.mine[0].customerName).toBe('Ana');
    expect(m.others.map((g) => g.ticketId)).toEqual(['tB']);
    expect(m.mineCount).toBe(2);
    expect(m.total).toBe(3);
  });
  it('reports tickets it cannot attribute yet', () => {
    const m = buildReadyModel([q('x1', 'tZ', 'READY', '2026-01-01T10:00:00')], [], 'me');
    expect(m.unknownTickets).toEqual(['tZ']);
    expect(m.mineCount).toBe(0);
  });
});

describe('ticketRules', () => {
  const base = { status: 'OPEN', payment_requested: false, line_items: [], timer_sessions: [] } as unknown as Ticket;
  const line = (status: string) => ({ id: status, status });
  it('cancel only when empty of non-voided lines and timer sessions', () => {
    expect(canCancelTable(base)).toBe(true);
    expect(canCancelTable({ ...base, line_items: [line('VOIDED')] } as unknown as Ticket)).toBe(true);
    expect(canCancelTable({ ...base, line_items: [line('SENT')] } as unknown as Ticket)).toBe(false);
    expect(canCancelTable({ ...base, timer_sessions: [{}] } as unknown as Ticket)).toBe(false);
    expect(canCancelTable({ ...base, status: 'CLOSED' } as Ticket)).toBe(false);
  });
  it('request bill needs something to bill and not already requested', () => {
    expect(canRequestBill(base)).toBe(false);
    expect(canRequestBill({ ...base, line_items: [line('SERVED')] } as unknown as Ticket)).toBe(true);
    expect(canRequestBill({ ...base, line_items: [line('SERVED')], payment_requested: true } as unknown as Ticket)).toBe(false);
    expect(canRequestBill({ ...base, timer_sessions: [{}] } as unknown as Ticket)).toBe(true);
  });
  it('finds the running timer', () => {
    const t = { timer_sessions: [{ start_time: 'a', end_time: 'b', status: 'COMPLETED' }, { start_time: 'c', end_time: null, status: 'ACTIVE' }] } as unknown as Ticket;
    expect(activeTimerStart(t)).toBe('c');
    expect(activeTimerStart({ timer_sessions: [] } as unknown as Ticket)).toBeNull();
  });
});
