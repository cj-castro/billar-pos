import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../../../api/client';
import { qk } from '../../../api/queryKeys';
import { revertItems, revertSet } from '../kdsActions';
import { ageLevelFor, newSentIds, queueSummary, resolveThresholds } from '../kdsModel';
import { qi } from '../testFixtures';

const TOK = { warnMin: 10, lateMin: 20 };

describe('revertSet', () => {
  it('keeps only ids whose steps succeeded', () => {
    expect(revertSet(['a', 'b', 'c'], [{ ok: true }, { ok: false }, { ok: true }])).toEqual(['a', 'c']);
    expect(revertSet(['a'], [])).toEqual([]);
  });
});

describe('revertItems', () => {
  it('patches READY lines back to IN_PROGRESS and rolls back a failed one', async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.queue('KITCHEN'), [qi({ id: 'a', status: 'READY' }), qi({ id: 'b', status: 'READY' })]);
    const api = { updateStatus: jest.fn(async (id: string) => (id === 'b' ? Promise.reject(new Error('x')) : {})) };
    const ok = await revertItems(qc, 'KITCHEN', ['a', 'b'], api);
    expect(ok).toBe('failed');
    const st = Object.fromEntries((qc.getQueryData(qk.queue('KITCHEN')) as { id: string; status: string }[]).map((i) => [i.id, i.status]));
    expect(st).toEqual({ a: 'IN_PROGRESS', b: 'READY' });
    expect(api.updateStatus).toHaveBeenCalledWith('a', 'IN_PROGRESS', 'READY');
    qc.clear();
  });

  it('409 STATUS_CHANGED means already served', async () => {
    const qc = new QueryClient();
    qc.setQueryData(qk.queue('KITCHEN'), [qi({ id: 'a', status: 'READY' })]);
    const api = { updateStatus: jest.fn().mockRejectedValue(new ApiError({ status: 409, code: 'STATUS_CHANGED', message: '' })) };
    expect(await revertItems(qc, 'KITCHEN', ['a'], api)).toBe('served');
    qc.clear();
  });
});

describe('newSentIds', () => {
  it('returns only unseen SENT lines', () => {
    const prev = [{ id: 'a' }, { id: 'b' }];
    const next = [
      { id: 'a', status: 'SENT' as const },
      { id: 'c', status: 'SENT' as const },
      { id: 'd', status: 'IN_PROGRESS' as const },
    ];
    expect(newSentIds(prev, next)).toEqual(['c']);
    expect(newSentIds(next, next)).toEqual([]);
  });
});

describe('queueSummary', () => {
  const now = Date.parse('2026-11-05T20:12:30Z');
  it('counts open lines and floors the oldest age in minutes', () => {
    const items = [
      qi({ id: '1', sent_at: '2026-11-05T20:00:00Z' }),
      qi({ id: '2', sent_at: '2026-11-05T20:10:00Z', status: 'IN_PROGRESS' }),
      qi({ id: '3', sent_at: '2026-11-05T19:00:00Z', status: 'READY' }),
    ];
    expect(queueSummary(items, now)).toEqual({ count: 2, oldestMin: 12 });
  });
  it('empty queue', () => expect(queueSummary([], now)).toEqual({ count: 0, oldestMin: null }));
});

describe('thresholds', () => {
  it('falls back to tokens on missing/garbage/inverted values', () => {
    expect(resolveThresholds(null, null, TOK)).toEqual(TOK);
    expect(resolveThresholds('abc', '0', TOK)).toEqual(TOK);
    expect(resolveThresholds('30', '15', TOK)).toEqual(TOK);
    expect(resolveThresholds('5', '12', TOK)).toEqual({ warnMin: 5, lateMin: 12 });
    expect(resolveThresholds('5', undefined, TOK)).toEqual({ warnMin: 5, lateMin: 20 });
  });
  it('ageLevelFor uses them (warn inclusive, alert strictly above)', () => {
    const th = { warnMin: 5, lateMin: 12 };
    expect([4.9, 5, 12, 12.1].map((m) => ageLevelFor(m, th))).toEqual(['neutral', 'warn', 'warn', 'alert']);
  });
});
