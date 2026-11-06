import { allReadyPlan, canTransition, groupQueue, newItemIds, nextStatus, pendingCount, stationForRole } from '../kdsModel';
import { kdsAgeLevel } from '../../../theme/tokens';
import { qi } from '../testFixtures';

describe('stationForRole', () => {
  it.each([
    ['KITCHEN_STAFF', 'KITCHEN'],
    ['BAR_STAFF', 'BAR'],
    ['MANAGER', null],
    ['ADMIN', null],
    ['WAITER', null],
    [undefined, null],
  ])('%s -> %s', (role, station) => expect(stationForRole(role)).toBe(station));
});

describe('next-status rule', () => {
  it('advances exactly one step', () => {
    expect(nextStatus('SENT')).toBe('IN_PROGRESS');
    expect(nextStatus('IN_PROGRESS')).toBe('READY');
  });
  it('READY/SERVED/VOIDED have no tap target (SERVED is an explicit action)', () => {
    expect(nextStatus('READY')).toBeNull();
    expect(nextStatus('SERVED')).toBeNull();
    expect(nextStatus('VOIDED')).toBeNull();
  });
  it('never skips steps and never revives', () => {
    expect(canTransition('SENT', 'READY')).toBe(false); // no skipping
    expect(canTransition('SENT', 'SERVED')).toBe(false);
    expect(canTransition('IN_PROGRESS', 'SERVED')).toBe(false);
    expect(canTransition('READY', 'IN_PROGRESS')).toBe(false); // no going back
    expect(canTransition('READY', 'READY')).toBe(false);
    expect(canTransition('SERVED', 'IN_PROGRESS')).toBe(false); // no revival
    expect(canTransition('VOIDED', 'IN_PROGRESS')).toBe(false);
    expect(canTransition('SENT', 'IN_PROGRESS')).toBe(true);
    expect(canTransition('IN_PROGRESS', 'READY')).toBe(true);
    expect(canTransition('READY', 'SERVED')).toBe(true);
  });
});

describe('allReadyPlan', () => {
  it('SENT needs two steps, IN_PROGRESS one, READY none', () => {
    expect(
      allReadyPlan([
        { id: 'a', status: 'SENT' },
        { id: 'b', status: 'IN_PROGRESS' },
        { id: 'c', status: 'READY' },
      ]),
    ).toEqual([
      { id: 'a', steps: ['IN_PROGRESS', 'READY'] },
      { id: 'b', steps: ['READY'] },
    ]);
  });
});

describe('groupQueue', () => {
  it('groups by ticket, oldest ticket first, items oldest first', () => {
    const groups = groupQueue(
      [
        qi({ id: 'a2', ticket_id: 'tB', resource_code: 'M2', sent_at: '2026-11-05T20:05:00+00:00' }),
        qi({ id: 'a1', ticket_id: 'tA', resource_code: 'M1', sent_at: '2026-11-05T20:10:00+00:00' }),
        qi({ id: 'a3', ticket_id: 'tB', resource_code: 'M2', sent_at: '2026-11-05T20:01:00+00:00' }),
      ],
      'Sin mesa',
    );
    expect(groups.map((g) => g.ticketId)).toEqual(['tB', 'tA']);
    expect(groups[0].items.map((i) => i.id)).toEqual(['a3', 'a2']);
    expect(groups[0].code).toBe('M2');
    expect(new Date(groups[0].oldestSentAt).toISOString()).toBe('2026-11-05T20:01:00.000Z');
  });

  it('age comes from the oldest un-READY item; all READY falls back to the oldest overall', () => {
    const mixed = groupQueue(
      [qi({ id: 'r', status: 'READY', sent_at: '2026-11-05T19:00:00+00:00' }), qi({ id: 'p', status: 'IN_PROGRESS', sent_at: '2026-11-05T20:00:00+00:00' })],
      'x',
    );
    expect(new Date(mixed[0].oldestSentAt).toISOString()).toBe('2026-11-05T20:00:00.000Z');
    const done = groupQueue([qi({ id: 'r', status: 'READY', sent_at: '2026-11-05T19:00:00+00:00' })], 'x');
    expect(new Date(done[0].oldestSentAt).toISOString()).toBe('2026-11-05T19:00:00.000Z');
  });

  it('drops voided/served lines, maps modifiers + notes, falls back when there is no table', () => {
    const groups = groupQueue(
      [
        qi({ id: 'v', status: 'VOIDED' }),
        qi({ id: 's', status: 'SERVED' }),
        qi({
          id: 'k',
          ticket_id: 'tX',
          resource_code: null,
          notes: 'sin cebolla',
          modifiers: [{ id: '1', modifier_id: 'm', name: 'Extra queso', price_cents: 0 }],
          quantity: 2,
        }),
      ],
      'Sin mesa',
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].code).toBe('Sin mesa');
    expect(groups[0].items[0]).toMatchObject({ id: 'k', quantity: 2, modifiers: ['Extra queso'], note: 'sin cebolla', name: 'Nachos' });
  });

  it('empty queue -> no groups', () => expect(groupQueue([], 'x')).toEqual([]));
});

describe('age levels (thresholds from theme tokens)', () => {
  it('neutral < 10, warn 10..20, alert > 20', () => {
    expect(kdsAgeLevel(9.99)).toBe('neutral');
    expect(kdsAgeLevel(10)).toBe('warn');
    expect(kdsAgeLevel(20)).toBe('warn');
    expect(kdsAgeLevel(20.01)).toBe('alert');
    expect(kdsAgeLevel(Number.NaN)).toBe('neutral');
  });
});

describe('newItemIds / pendingCount', () => {
  it('reports only ids not seen before', () => {
    expect(newItemIds([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }])).toEqual(['b']);
    expect(newItemIds([], [])).toEqual([]);
  });
  it('pending = SENT + IN_PROGRESS', () => {
    expect(pendingCount([{ status: 'SENT' }, { status: 'IN_PROGRESS' }, { status: 'READY' }])).toBe(2);
  });
});
