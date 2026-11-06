import { ApiError } from '../../../api/client';
import { sendDraft, sendableLines, type LinePatch, type SendDeps, type SendLine } from '../draft/sendOrchestrator';
import type { DraftLine } from '../draft/draftStore';

const L = (key: string, over: Partial<SendLine> = {}): SendLine => ({ key, menuItemId: `item-${key}`, quantity: 1, modifiers: [], notes: '', ...over });
const err = (status: number | null, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
  new ApiError({ status, code, message: '', ...extra });
const netErr = () => err(null, 'NETWORK_ERROR', { isNetwork: true });

type AddResult = { ticket_version?: number } | Error;

function setup(script: Record<string, AddResult[]>, versions: (number | null)[] = [7]) {
  const calls: { key: string; version?: number; body: unknown }[] = [];
  const patches: [string, LinePatch][] = [];
  const queue = { ...script };
  const vq = [...versions];
  const deps: SendDeps = {
    addItem: jest.fn(async (_t, body, opts) => {
      calls.push({ key: opts.idempotencyKey, version: opts.ticketVersion, body });
      const next = queue[opts.idempotencyKey]?.shift();
      if (next === undefined) throw new Error(`unscripted call for ${opts.idempotencyKey}`);
      if (next instanceof Error) throw next;
      return next;
    }),
    fetchVersion: jest.fn(async () => (vq.length > 1 ? vq.shift()! : (vq[0] ?? null))),
  };
  const onUpdate = (k: string, p: LinePatch) => patches.push([k, p]);
  return { deps, calls, patches, onUpdate };
}
const last = (patches: [string, LinePatch][], key: string) => [...patches].reverse().find(([k]) => k === key)?.[1];

describe('sendDraft', () => {
  it('201 with B1: posts sequentially with the draft key and chains the version from each response', async () => {
    const s = setup({ a: [{ ticket_version: 8 }], b: [{ ticket_version: 9 }] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b', { quantity: 2, notes: 'sin hielo', modifiers: [{ id: 'm1' }] })], version: 7, deps: s.deps, onUpdate: s.onUpdate });
    expect(r).toMatchObject({ sent: ['a', 'b'], failed: [], stopped: null, b1: true, version: 9 });
    expect(s.calls.map((c) => [c.key, c.version])).toEqual([['a', 7], ['b', 8]]);
    expect(s.calls[1].body).toEqual({ menu_item_id: 'item-b', quantity: 2, modifiers: [{ modifier_id: 'm1' }], notes: 'sin hielo' });
    expect(s.deps.fetchVersion).not.toHaveBeenCalled(); // no extra refetch when B1 answers
    expect(last(s.patches, 'a')).toEqual({ state: 'SENT' });
  });

  it('200 replay of an existing key counts as sent (same as 201)', async () => {
    // the API layer returns the line JSON for both; an already-existing key is just another success
    const s = setup({ a: [{ ticket_version: 12 }] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a')], version: 3, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.sent).toEqual(['a']);
    expect(r.version).toBe(12);
  });

  it('without B1 (no ticket_version) it refetches the version after every success', async () => {
    const s = setup({ a: [{}], b: [{}] }, [8, 9]);
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b')], version: 7, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.b1).toBe(false);
    expect(s.calls.map((c) => c.version)).toEqual([7, 8]);
    expect(s.deps.fetchVersion).toHaveBeenCalledTimes(2);
  });

  it('409 VERSION_CONFLICT with B1: refetches and retries ONCE with the same key', async () => {
    const s = setup({ a: [err(409, 'VERSION_CONFLICT'), { ticket_version: 11 }] }, [10]);
    const r = await sendDraft({ ticketId: 't', lines: [L('a')], version: 7, b1Known: true, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.sent).toEqual(['a']);
    expect(s.calls.map((c) => [c.key, c.version])).toEqual([['a', 7], ['a', 10]]);
  });

  it('409 VERSION_CONFLICT twice with B1: gives up as "verify", no third POST', async () => {
    const s = setup({ a: [err(409, 'VERSION_CONFLICT'), err(409, 'VERSION_CONFLICT')], b: [{}] }, [10]);
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b')], version: 7, b1Known: true, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.stopped).toBe('verify');
    expect(s.calls).toHaveLength(2);
    expect(last(s.patches, 'a')).toEqual({ state: 'FAILED', error: 'VERIFY' });
    expect(s.calls.some((c) => c.key === 'b')).toBe(false);
  });

  it('409 VERSION_CONFLICT without B1: marks "verify" and stops WITHOUT resending (no duplicate risk)', async () => {
    const s = setup({ a: [err(409, 'VERSION_CONFLICT')], b: [{}] }, [10]);
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b')], version: 7, deps: s.deps, onUpdate: s.onUpdate });
    expect(r).toMatchObject({ sent: [], failed: ['a'], stopped: 'verify', version: 10 });
    expect(s.calls).toHaveLength(1);
    expect(last(s.patches, 'a')).toEqual({ state: 'FAILED', error: 'VERIFY' });
  });

  it('422 errors mark only that line and the others continue', async () => {
    const s = setup({
      a: [err(422, 'OUT_OF_STOCK')],
      b: [err(422, 'FLAVOR_REQUIRED')],
      c: [err(422, 'INVALID_QUANTITY')],
      d: [{ ticket_version: 20 }],
    });
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b'), L('c'), L('d')], version: 1, deps: s.deps, onUpdate: s.onUpdate });
    expect(r).toMatchObject({ sent: ['d'], failed: ['a', 'b', 'c'], stopped: null });
    expect(last(s.patches, 'a')).toMatchObject({ state: 'FAILED', error: 'OUT_OF_STOCK' });
    expect(last(s.patches, 'b')).toMatchObject({ state: 'FAILED', error: 'FLAVOR_REQUIRED' });
    expect(last(s.patches, 'c')).toMatchObject({ state: 'FAILED', error: 'INVALID_QUANTITY' });
  });

  it('403 TICKET_CLOSED stops everything; the line stays pending (draft kept)', async () => {
    const s = setup({ a: [err(403, 'TICKET_CLOSED')], b: [{}] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b')], version: 1, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.stopped).toBe('closed');
    expect(r.sent).toEqual([]);
    expect(last(s.patches, 'a')).toEqual({ state: 'PENDING' });
    expect(s.calls).toHaveLength(1);
  });

  it('401 (refresh already failed in the client) stops and keeps the line', async () => {
    const s = setup({ a: [err(401, 'NO_REFRESH_TOKEN')] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a')], version: 1, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.stopped).toBe('unauthorized');
    expect(last(s.patches, 'a')).toEqual({ state: 'PENDING' });
  });

  it('network failure mid-send: earlier lines stay sent, the failing one is "not sent", later ones untouched', async () => {
    const s = setup({ a: [{ ticket_version: 2 }], b: [netErr()], c: [{}] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b'), L('c')], version: 1, deps: s.deps, onUpdate: s.onUpdate });
    expect(r).toMatchObject({ sent: ['a'], failed: ['b'], stopped: 'network' });
    expect(last(s.patches, 'b')).toEqual({ state: 'FAILED', error: 'NETWORK' });
    expect(s.patches.some(([k]) => k === 'c')).toBe(false);
  });

  it('retry after a network failure reuses the SAME key, and never re-posts confirmed lines', async () => {
    const s1 = setup({ a: [{ ticket_version: 2 }], b: [netErr()] });
    const lines = [L('a'), L('b'), L('c')];
    const first = await sendDraft({ ticketId: 't', lines, version: 1, deps: s1.deps, onUpdate: s1.onUpdate });
    // the hook drops confirmed lines from the draft; the failed + untouched ones are retried
    const remaining = lines.filter((l) => !first.sent.includes(l.key));
    expect(remaining.map((l) => l.key)).toEqual(['b', 'c']);
    const s2 = setup({ b: [{ ticket_version: 3 }], c: [{ ticket_version: 4 }] });
    const second = await sendDraft({ ticketId: 't', lines: remaining, version: 2, b1Known: first.b1, deps: s2.deps, onUpdate: s2.onUpdate });
    expect(second.sent).toEqual(['b', 'c']);
    expect(s2.calls.map((c) => c.key)).toEqual(['b', 'c']);
    const allKeys = [...s1.calls, ...s2.calls].map((c) => c.key);
    expect(allKeys.filter((k) => k === 'a')).toHaveLength(1); // never duplicated
    expect(allKeys.filter((k) => k === 'b')).toHaveLength(2); // same key twice: server dedupes (B1)
  });

  it('timeout and 5xx are "outcome unknown": keep the key and stop', async () => {
    const t = setup({ a: [err(null, 'TIMEOUT', { isTimeout: true })] });
    expect((await sendDraft({ ticketId: 't', lines: [L('a')], version: 1, deps: t.deps, onUpdate: t.onUpdate })).stopped).toBe('network');
    const e = setup({ a: [err(502, 'HTTP_502')] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a')], version: 1, deps: e.deps, onUpdate: e.onUpdate });
    expect(r.stopped).toBe('network');
    expect(last(e.patches, 'a')).toEqual({ state: 'FAILED', error: 'SERVER' });
  });

  it('an unreadable version (fetch fails) just omits X-Ticket-Version', async () => {
    const s = setup({ a: [{}] });
    (s.deps.fetchVersion as jest.Mock).mockRejectedValue(netErr());
    await sendDraft({ ticketId: 't', lines: [L('a')], version: 5, deps: s.deps, onUpdate: s.onUpdate });
    expect(s.calls[0].version).toBe(5);
  });

  it('never sends a line twice in one run', async () => {
    const s = setup({ a: [{ ticket_version: 2 }], b: [{ ticket_version: 3 }] });
    await sendDraft({ ticketId: 't', lines: [L('a'), L('b')], version: 1, deps: s.deps, onUpdate: s.onUpdate });
    const keys = s.calls.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('sendableLines', () => {
  const d = (key: string, state: DraftLine['state'], error?: DraftLine['error']): DraftLine => ({ key, menuItemId: 'm', name: 'n', unitPriceCents: 1, quantity: 1, modifiers: [], notes: '', state, error, addedAt: 0 });
  it('includes pending + transient failures, excludes dead lines and in-flight ones', () => {
    const lines = [d('p', 'PENDING'), d('n', 'FAILED', 'NETWORK'), d('s', 'FAILED', 'SERVER'), d('o', 'FAILED', 'OUT_OF_STOCK'), d('v', 'FAILED', 'VERIFY'), d('x', 'SENDING')];
    expect(sendableLines(lines).map((l) => l.key)).toEqual(['p', 'n', 's']);
  });
});
