import { QueryClient } from '@tanstack/react-query';
import { handleRealtimeEvent, invalidationsFor, onRealtimeEvent, roomsForRole } from '../socket';

describe('invalidation map', () => {
  it.each([
    ['floor:update', {}, [['resources']]],
    ['kitchen:update', {}, [['queue', 'KITCHEN'], ['queue', 'counts']]],
    ['kitchen:item_update', { item_id: 'i' }, [['queue', 'KITCHEN'], ['queue', 'counts']]],
    ['bar:update', {}, [['queue', 'BAR'], ['queue', 'counts']]],
    ['bar:item_update', {}, [['queue', 'BAR'], ['queue', 'counts']]],
    ['ticket:updated', { ticket_id: 't1' }, [['ticket', 't1']]],
    ['ticket:item_status', { ticket_id: 't2' }, [['ticket', 't2']]],
    ['ticket:item_status', { item_id: 'i', status: 'READY' }, [['ticket']]],
    ['waiting:update', {}, [['waiting']]],
    ['waiting_list:update', {}, [['waiting']]],
    ['settings:changed', { key: 'kds_sound_enabled', value: 'true' }, [['settings', 'kds_sound_enabled']]],
    ['settings:changed', undefined, [['settings']]],
    ['unknown:event', {}, []],
  ])('%s %j', (event, payload, expected) => {
    expect(invalidationsFor(event, payload)).toEqual(expected);
  });

  it('invalidates matching cached queries', () => {
    const qc = new QueryClient();
    qc.setQueryData(['ticket', 't1'], { a: 1 });
    qc.setQueryData(['ticket', 't2'], { a: 2 });
    handleRealtimeEvent('ticket:updated', { ticket_id: 't1' }, qc);
    expect(qc.getQueryState(['ticket', 't1'])?.isInvalidated).toBe(true);
    expect(qc.getQueryState(['ticket', 't2'])?.isInvalidated).toBe(false);
  });
});

describe('rooms and subscriptions', () => {
  it('role-based rooms', () => {
    const names = (r: string) => roomsForRole(r).map((x) => x.room);
    expect(names('WAITER')).toEqual(['floor']);
    expect(names('KITCHEN_STAFF')).toEqual(['floor', 'kitchen']);
    expect(names('BAR_STAFF')).toEqual(['floor', 'bar']);
    expect(names('MANAGER')).toEqual(['floor', 'kitchen', 'bar', 'manager']);
    expect(roomsForRole('MANAGER').find((r) => r.room === 'manager')?.withToken).toBe(true);
  });

  it('onRealtimeEvent returns an unsubscribe', () => {
    const fn = jest.fn();
    const off = onRealtimeEvent('x', fn);
    off();
    expect(fn).not.toHaveBeenCalled();
  });
});
