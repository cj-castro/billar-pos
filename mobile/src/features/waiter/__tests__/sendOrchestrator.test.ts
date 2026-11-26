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
  it('201: posts sequentially with the draft key and chains the version from each response', async () => {
    const s = setup({ a: [{ ticket_version: 8 }], b: [{ ticket_version: 9 }] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b', { quantity: 2, notes: 'sin hielo', modifiers: [{ id: 'm1' }] })], version: 7, deps: s.deps, onUpdate: s.onUpdate });
    expect(r).toMatchObject({ sent: ['a', 'b'], failed: [], stopped: null, version: 9 });
    expect(s.calls.map((c) => [c.key, c.version])).toEqual([['a', 7], ['b', 8]]);
    expect(s.calls[1].body).toEqual({ menu_item_id: 'item-b', quantity: 2, modifiers: [{ modifier_id: 'm1' }], notes: 'sin hielo' });
    expect(s.deps.fetchVersion).not.toHaveBeenCalled(); // no extra refetch when the response carries the version
    expect(last(s.patches, 'a')).toEqual({ state: 'SENT' });
  });

  it('200 replay of an existing key counts as sent (same as 201)', async () => {
    // the API layer returns the line JSON for both; an already-existing key is just another success
    const s = setup({ a: [{ ticket_version: 12 }] });
    const r = await sendDraft({ ticketId: 't', lines: [L('a')], version: 3, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.sent).toEqual(['a']);
    expect(r.version).toBe(12);
  });

  it('a response without ticket_version refetches the version after every success', async () => {
    const s = setup({ a: [{}], b: [{}] }, [8, 9]);
    await sendDraft({ ticketId: 't', lines: [L('a'), L('b')], version: 7, deps: s.deps, onUpdate: s.onUpdate });
    expect(s.calls.map((c) => c.version)).toEqual([7, 8]);
    expect(s.deps.fetchVersion).toHaveBeenCalledTimes(2);
  });

  it('409 VERSION_CONFLICT: refetches and retries ONCE with the same key', async () => {
    const s = setup({ a: [err(409, 'VERSION_CONFLICT'), { ticket_version: 11 }] }, [10]);
    const r = await sendDraft({ ticketId: 't', lines: [L('a')], version: 7, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.sent).toEqual(['a']);
    expect(s.calls.map((c) => [c.key, c.version])).toEqual([['a', 7], ['a', 10]]);
  });

  it('409 VERSION_CONFLICT twice: gives up as "verify", no third POST', async () => {
    const s = setup({ a: [err(409, 'VERSION_CONFLICT'), err(409, 'VERSION_CONFLICT')], b: [{}] }, [10]);
    const r = await sendDraft({ ticketId: 't', lines: [L('a'), L('b')], version: 7, deps: s.deps, onUpdate: s.onUpdate });
    expect(r.stopped).toBe('verify');
    expect(s.calls).toHaveLength(2);
    expect(last(s.patches, 'a')).toEqual({ state: 'FAILED', error: 'VERIFY' });
    expect(s.calls.some((c) => c.key === 'b')).toBe(false);
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
    const second = await sendDraft({ ticketId: 't', lines: remaining, version: 2, deps: s2.deps, onUpdate: s2.onUpdate });
    expect(second.sent).toEqual(['b', 'c']);
    expect(s2.calls.map((c) => c.key)).toEqual(['b', 'c']);
    const allKeys = [...s1.calls, ...s2.calls].map((c) => c.key);
    expect(allKeys.filter((k) => k === 'a')).toHaveLength(1); // never duplicated
    expect(allKeys.filter((k) => k === 'b')).toHaveLength(2); // same key twice: server dedupes
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

/** Fake POS: optionally "applies the request but loses the response" (the ambiguous case that causes duplicates). */
function fakePos(opts: { version?: number } = {}) {
  const st = { version: opts.version ?? 7, adds: 0, byKey: new Map<string, number>(), loseNextResponse: false, dropNextRequest: false, headers: [] as (number | undefined)[] };
  const deps: SendDeps = {
    addItem: jest.fn(async (_t, _b, o) => {
      st.headers.push(o.ticketVersion);
      if (st.dropNextRequest) {
        st.dropNextRequest = false;
        throw netErr();
      }
      if (st.byKey.has(o.idempotencyKey)) return { ticket_version: st.version };
      if (o.ticketVersion != null && o.ticketVersion !== st.version) throw err(409, 'VERSION_CONFLICT');
      st.adds += 1;
      st.version += 1;
      st.byKey.set(o.idempotencyKey, st.version);
      if (st.loseNextResponse) {
        st.loseNextResponse = false;
        throw netErr(); // applied server side, client never sees the answer
      }
      return { ticket_version: st.version };
    }),
    fetchVersion: jest.fn(async () => st.version),
  };
  return { st, deps };
}

/** Minimal draft-line bookkeeping, same rules as useSendDraft's onUpdate. */
function draftOf(key: string): SendLine & { state: string } {
  return { ...L(key), state: 'PENDING' };
}
const apply = (line: SendLine & { state: string }) => (_k: string, p: LinePatch) => {
  line.state = p.state;
  if (p.state === 'SENDING' && 'firstAttemptVersion' in p) line.firstAttemptVersion = p.firstAttemptVersion;
  if (p.state === 'FAILED' && p.resetAttempt) line.firstAttemptVersion = undefined;
};

describe('H1: retry of an uncertain line', () => {
  it('response lost: same key, refreshed version, the server dedupes -> sent, one add', async () => {
    const pos = fakePos();
    const line = draftOf('a');
    pos.st.loseNextResponse = true;
    await sendDraft({ ticketId: 't', lines: [line], version: 7, deps: pos.deps, onUpdate: apply(line) });
    expect(pos.st.adds).toBe(1);
    // a second waiter bumped the version meanwhile
    pos.st.version += 1;
    const retry = await sendDraft({ ticketId: 't', lines: [line], version: pos.st.version, deps: pos.deps, onUpdate: apply(line) });
    expect(retry).toMatchObject({ sent: ['a'], stopped: null });
    expect(pos.st.adds).toBe(1);
  });

  it('a 409 on the retry: refreshes the version and retries ONCE with the same key', async () => {
    const pos = fakePos();
    const line = { ...draftOf('a'), firstAttemptVersion: 3 as number | null }; // stale first version, key unknown to the server yet
    const r = await sendDraft({ ticketId: 't', lines: [line], version: 7, deps: pos.deps, onUpdate: apply(line) });
    expect(r.sent).toEqual(['a']);
    expect(pos.st.adds).toBe(1);
  });

  it('a definitive 422 resets the attempt so the line is fresh (editable) again', async () => {
    const line = draftOf('a');
    const s = setup({ a: [err(422, 'OUT_OF_STOCK')] });
    await sendDraft({ ticketId: 't', lines: [line], version: 7, deps: s.deps, onUpdate: apply(line) });
    expect(line.firstAttemptVersion).toBeUndefined();
  });
});
