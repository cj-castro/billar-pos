import { applyPadKey, buildCloseBody, cashChips, classifyCloseError, derive, initialPay, setPart, tipCents, type PayState } from '../pay/payModel';

const st = (over: Partial<PayState> = {}): PayState => ({ ...initialPay(false), ...over });

describe('tip math', () => {
  it('none / pct / custom', () => {
    expect(tipCents(14500, { kind: 'none' })).toBe(0);
    expect(tipCents(14500, { kind: 'pct', pct: 10 })).toBe(1450);
    expect(tipCents(14333, { kind: 'pct', pct: 15 })).toBe(2150);
    expect(tipCents(14500, { kind: 'custom', cents: 3000 })).toBe(3000);
  });
});

describe('derive', () => {
  it('cash: change and validity', () => {
    const v = derive(14500, st({ tip: { kind: 'pct', pct: 10 }, cashCents: 20000 }));
    expect(v).toMatchObject({ tip: 1450, due: 15950, change: 4050, valid: true });
    expect(derive(14500, st({ cashCents: 10000 }))).toMatchObject({ valid: false, reason: 'cashLow', short: 4500 });
  });
  it('card and external are always valid; external ignores tip', () => {
    expect(derive(14500, st({ method: 'CARD', tip: { kind: 'pct', pct: 10 } }))).toMatchObject({ valid: true, card: 15950 });
    expect(derive(14500, st({ method: 'EXTERNAL', tip: { kind: 'pct', pct: 10 } }))).toMatchObject({ valid: true, tip: 0, due: 14500 });
  });
  it('mixto: typing one side auto-fills the remainder on the other, override flips the authority', () => {
    const s = setPart(st({ method: 'MIXTO' }), 'cash', 5000);
    expect(derive(14500, s)).toMatchObject({ cash: 5000, card: 9500, valid: true, change: 0 });
    expect(derive(14500, setPart(s, 'card', 4000))).toMatchObject({ card: 4000, cash: 10500, valid: true });
  });
  it('mixto: needs both parts and change must come out of cash', () => {
    expect(derive(14500, st({ method: 'MIXTO' }))).toMatchObject({ valid: false, reason: 'mixedParts' });
    expect(derive(14500, setPart(st({ method: 'MIXTO' }), 'cash', 14500))).toMatchObject({ valid: false, reason: 'mixedParts' });
    expect(derive(14500, setPart(st({ method: 'MIXTO' }), 'cash', 20000))).toMatchObject({ valid: false });
  });
});

describe('cashChips / pad', () => {
  it('exact then next 50/100/200/500 above, deduped', () => {
    expect(cashChips(14500)).toEqual([14500, 15000, 20000, 50000]);
    expect(cashChips(10000)).toEqual([10000, 20000, 50000]);
    expect(cashChips(23000)).toEqual([23000, 25000, 30000, 40000, 50000]);
  });
  it('pad appends, doubles zero, backspaces, caps', () => {
    expect(applyPadKey(0, '5')).toBe(500);
    expect(applyPadKey(500, '0')).toBe(5000);
    expect(applyPadKey(500, '00')).toBe(50000);
    expect(applyPadKey(12300, 'back')).toBe(1200);
    expect(applyPadKey(100_000_000, '9')).toBe(100_000_000);
  });
});

describe('buildCloseBody', () => {
  it('cash sends tendered, tip source CASH, expected total', () => {
    expect(buildCloseBody(14500, st({ cashCents: 15000, tip: { kind: 'pct', pct: 10 } }))).toEqual({
      payment_type: 'CASH',
      tendered_cents: 15000,
      tip_cents: 1450,
      tip_source: 'CASH',
      expected_total_cents: 14500,
    });
  });
  it('card and external omit tendered', () => {
    expect(buildCloseBody(14500, st({ method: 'CARD' }))).toEqual({ payment_type: 'CARD', tip_cents: 0, tip_source: 'CARD', expected_total_cents: 14500 });
    expect(buildCloseBody(14500, st({ method: 'EXTERNAL' }))).toEqual({ payment_type: 'EXTERNAL', tip_cents: 0, expected_total_cents: 14500 });
  });
  it('mixto splits the tip proportionally and the parts sum exactly', () => {
    const s = setPart(st({ method: 'MIXTO', tip: { kind: 'custom', cents: 1001 } }), 'cash', 5000);
    const b = buildCloseBody(10000, s);
    expect(b).toMatchObject({ payment_type: 'CASH', payment_type_2: 'CARD', tendered_cents: 5000, tendered_cents_2: 6001, tip_source: 'SPLIT' });
    expect(b.tip_cash_cents! + b.tip_card_cents!).toBe(1001);
    expect(b.tip_cash_cents).toBe(Math.round((1001 * 5000) / 11001));
  });
});

describe('classifyCloseError', () => {
  it.each([
    [422, 'INSUFFICIENT_PAYMENT', 'insufficient'],
    [422, 'AMOUNT_MISMATCH', 'insufficient'],
    [409, 'TICKET_NOT_OPEN', 'notOpen'],
    [409, 'VERSION_CONFLICT', 'conflict'],
    [403, 'PIN_REQUIRED', 'pin'],
    [403, 'BAR_CLOSED', 'barClosed'],
    [429, 'PIN_LOCKED', 'pinLocked'],
    [500, 'X', 'other'],
  ] as const)('%s %s -> %s', (status, code, kind) => expect(classifyCloseError({ status, code })).toBe(kind));
});
