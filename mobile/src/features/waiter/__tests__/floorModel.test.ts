import { expressChips, timerText, unsentSummary } from '../floor/floorModel';

describe('timerText', () => {
  const start = '2026-01-01T10:00:00.000Z';
  const at = (s: number) => Date.parse(start) + s * 1000;
  it('formats mm:ss and h:mm:ss', () => {
    expect(timerText(start, at(65))).toBe('01:05');
    expect(timerText(start, at(3725))).toBe('1:02:05');
  });
  it('never goes negative (device behind the server)', () => expect(timerText(start, at(-5))).toBe('00:00'));
  it('frozen (offline) is prefixed with ~', () => expect(timerText(start, at(61), true)).toBe('~01:01'));
  it('empty without a valid start', () => {
    expect(timerText(null, 0)).toBe('');
    expect(timerText('nope', 0)).toBe('');
  });
});

describe('expressChips', () => {
  const tk = (id: string, opened_at: string, over: object = {}) => ({ id, opened_at, ticket_type: 'EXPRESS' as const, status: 'OPEN' as const, customer_name: null, ...over });
  it('keeps open EXPRESS only, oldest first, numbered', () => {
    const out = expressChips([
      tk('b', '2026-01-01T11:00'),
      tk('a', '2026-01-01T10:00', { customer_name: ' Luis ' }),
      tk('t', '2026-01-01T09:00', { ticket_type: 'TABLE' }),
      tk('c', '2026-01-01T08:00', { status: 'CLOSED' }),
    ]);
    expect(out).toEqual([
      { id: 'a', name: 'Luis', n: 1 },
      { id: 'b', name: null, n: 2 },
    ]);
  });
});

describe('unsentSummary', () => {
  it('null when every draft is empty', () => expect(unsentSummary({ t1: [] })).toBeNull());
  it('counts tickets with lines and points at the most recently touched', () => {
    expect(unsentSummary({ t1: [{ addedAt: 10 }], t2: [{ addedAt: 5 }, { addedAt: 30 }], t3: [] })).toEqual({ count: 2, ticketId: 't2' });
  });
});
