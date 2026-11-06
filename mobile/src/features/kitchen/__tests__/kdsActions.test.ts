import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../../../api/client';
import { qk } from '../../../api/queryKeys';
import type { QueueItem } from '../../../domain/types';
import { advanceAllReady, advanceItem } from '../kdsActions';
import { qi } from '../testFixtures';

const statusOf = (qc: QueryClient, id: string) => qc.getQueryData<QueueItem[]>(qk.queue('KITCHEN'))?.find((i) => i.id === id)?.status;
const clients: QueryClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.clear())); // clears gc timers so Jest can exit
const setup = (items: QueueItem[]) => {
  const qc = new QueryClient();
  clients.push(qc);
  qc.setQueryData(qk.queue('KITCHEN'), items);
  return qc;
};

describe('advanceItem', () => {
  it('updates the cache optimistically BEFORE the server answers', async () => {
    const qc = setup([qi({ id: 'a' })]);
    let release!: () => void;
    const api = { updateStatus: jest.fn(() => new Promise((r) => (release = () => r({})))) };
    const p = advanceItem(qc, 'KITCHEN', { id: 'a', status: 'SENT' }, 'IN_PROGRESS', api);
    await new Promise((r) => setTimeout(r, 0));
    expect(statusOf(qc, 'a')).toBe('IN_PROGRESS');
    release();
    expect(await p).toEqual({ ok: true });
    expect(api.updateStatus).toHaveBeenCalledWith('a', 'IN_PROGRESS');
  });

  it('rolls back only that item when the request fails', async () => {
    const qc = setup([qi({ id: 'a' }), qi({ id: 'b', status: 'IN_PROGRESS' })]);
    const api = { updateStatus: jest.fn().mockRejectedValue(new ApiError({ code: 'NETWORK_ERROR', message: 'x', isNetwork: true })) };
    const res = await advanceItem(qc, 'KITCHEN', { id: 'a', status: 'SENT' }, 'IN_PROGRESS', api);
    expect(res).toMatchObject({ ok: false, voided: false });
    expect(statusOf(qc, 'a')).toBe('SENT');
    expect(statusOf(qc, 'b')).toBe('IN_PROGRESS'); // untouched
  });

  it('409 ITEM_VOIDED removes the item and flags it as voided', async () => {
    const qc = setup([qi({ id: 'a' }), qi({ id: 'b' })]);
    const api = { updateStatus: jest.fn().mockRejectedValue(new ApiError({ status: 409, code: 'ITEM_VOIDED', message: 'voided' })) };
    const res = await advanceItem(qc, 'KITCHEN', { id: 'a', status: 'SENT' }, 'IN_PROGRESS', api);
    expect(res).toMatchObject({ ok: false, voided: true });
    expect(qc.getQueryData<QueueItem[]>(qk.queue('KITCHEN'))?.map((i) => i.id)).toEqual(['b']);
  });

  it('another 409 (not ITEM_VOIDED) is a normal failure with rollback', async () => {
    const qc = setup([qi({ id: 'a' })]);
    const api = { updateStatus: jest.fn().mockRejectedValue(new ApiError({ status: 409, code: 'VERSION_CONFLICT', message: '' })) };
    const res = await advanceItem(qc, 'KITCHEN', { id: 'a', status: 'SENT' }, 'IN_PROGRESS', api);
    expect(res).toMatchObject({ ok: false, voided: false });
    expect(statusOf(qc, 'a')).toBe('SENT');
  });

  it('illegal transitions never reach the network or the cache', async () => {
    const qc = setup([qi({ id: 'a' })]);
    const api = { updateStatus: jest.fn() };
    const res = await advanceItem(qc, 'KITCHEN', { id: 'a', status: 'SENT' }, 'READY', api);
    expect(res.ok).toBe(false);
    expect(api.updateStatus).not.toHaveBeenCalled();
    expect(statusOf(qc, 'a')).toBe('SENT');
  });

  it('READY -> SERVED removes the item from the queue', async () => {
    const qc = setup([qi({ id: 'a', status: 'READY' })]);
    const api = { updateStatus: jest.fn().mockResolvedValue({}) };
    expect((await advanceItem(qc, 'KITCHEN', { id: 'a', status: 'READY' }, 'SERVED', api)).ok).toBe(true);
    expect(qc.getQueryData<QueueItem[]>(qk.queue('KITCHEN'))).toEqual([]);
  });
});

describe('advanceAllReady', () => {
  it('SENT items get two SEQUENTIAL patches, IN_PROGRESS one, READY none', async () => {
    const qc = setup([qi({ id: 's' }), qi({ id: 'p', status: 'IN_PROGRESS' }), qi({ id: 'r', status: 'READY' })]);
    const calls: string[] = [];
    const api = {
      updateStatus: jest.fn(async (id: string, st: string) => {
        calls.push(`${id}:${st}:start`);
        await Promise.resolve();
        calls.push(`${id}:${st}:end`);
        return {};
      }),
    };
    const res = await advanceAllReady(qc, 'KITCHEN', [{ id: 's', status: 'SENT' }, { id: 'p', status: 'IN_PROGRESS' }, { id: 'r', status: 'READY' }], api);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(api.updateStatus).toHaveBeenCalledTimes(3);
    // s: READY patch starts only after IN_PROGRESS finished
    expect(calls.indexOf('s:IN_PROGRESS:end')).toBeLessThan(calls.indexOf('s:READY:start'));
    expect(statusOf(qc, 's')).toBe('READY');
    expect(statusOf(qc, 'p')).toBe('READY');
  });

  it('a failing second step leaves the item at IN_PROGRESS (what the server has)', async () => {
    const qc = setup([qi({ id: 's' })]);
    const api = {
      updateStatus: jest.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new ApiError({ status: 500, code: 'HTTP_500', message: '' })),
    };
    const [res] = await advanceAllReady(qc, 'KITCHEN', [{ id: 's', status: 'SENT' }], api);
    expect(res.ok).toBe(false);
    expect(statusOf(qc, 's')).toBe('IN_PROGRESS');
  });
});
