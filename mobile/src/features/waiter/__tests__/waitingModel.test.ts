import type { WaitingEntry } from '../../../api/endpoints/waitingList';
import { resource } from '../testing/testkit';
import { canAssign, freeTablesByGroup, isFreeTable, visibleEntries, waitText } from '../waiting/waitingModel';

const entry = (over: Partial<WaitingEntry>): WaitingEntry => ({ id: 'w1', party_name: 'Ana', party_size: 2, status: 'WAITING', position: 1, created_at: '2026-01-01T10:00:00Z', ...over });

describe('waitText', () => {
  it('adds the time since the fetch to the server wait', () => {
    expect(waitText(125, 1_000, 1_000)).toBe('02:05');
    expect(waitText(125, 1_000, 11_000)).toBe('02:15');
  });
  it('tolerates a missing wait and a clock that went backwards', () => {
    expect(waitText(null, 5_000, 4_000)).toBe('00:00');
    expect(waitText(undefined, 0, 61_000)).toBe('01:01');
  });
});

describe('assign eligibility', () => {
  it('WAITING and SEATED can be assigned, the rest cannot', () => {
    expect(canAssign(entry({ status: 'WAITING' }))).toBe(true);
    expect(canAssign(entry({ status: 'SEATED' }))).toBe(true);
    for (const status of ['ASSIGNED', 'CANCELLED', 'NO_SHOW'] as const) expect(canAssign(entry({ status }))).toBe(false);
  });
  it('visibleEntries drops ineligible rows and sorts by position', () => {
    expect(visibleEntries([entry({ id: 'b', position: 2 }), entry({ id: 'x', status: 'CANCELLED' }), entry({ id: 'a', position: 1 })]).map((e) => e.id)).toEqual(['a', 'b']);
  });
  it('a free table is active, AVAILABLE and has no open ticket (a pool awaiting payment is not free)', () => {
    expect(isFreeTable(resource({}))).toBe(true);
    expect(isFreeTable(resource({ status: 'IN_USE' }))).toBe(false);
    expect(isFreeTable(resource({ status: 'AVAILABLE', active_ticket_id: 'tk' }))).toBe(false);
    expect(isFreeTable(resource({ is_active: false }))).toBe(false);
    expect(isFreeTable(resource({ status: 'INACTIVE' }))).toBe(false);
  });
  it('groups free tables Billar / Mesas / Barra in natural order and drops empty groups', () => {
    const out = freeTablesByGroup([
      resource({ id: '1', code: 'T10', sort_order: 2 }),
      resource({ id: '2', code: 'T2', sort_order: 2 }),
      resource({ id: '3', code: 'BT1', type: 'POOL_TABLE' }),
      resource({ id: '4', code: 'B1', type: 'BAR_SEAT', status: 'IN_USE' }),
    ]);
    expect(out.map((g) => g.group)).toEqual(['POOL', 'TABLE']);
    expect(out[1].tables.map((r) => r.code)).toEqual(['T2', 'T10']);
  });
});
