import { applyPadKey, canClose, canCloseCounted, clampTo, leftExceedsKey, parseQty, splitEnvelope, toApi, totalCents, type Denom, cashDifference, diffTone, expenseBody, openTicketsCount, recentSessions, validateExpense } from '../cash/cashModel';

describe('cash close math', () => {
  it('difference = counted - expected (server sign): sobrante > 0, faltante < 0', () => {
    expect(cashDifference(105000, 104000)).toBe(1000);
    expect(cashDifference(100000, 104000)).toBe(-4000);
    expect(diffTone(0)).toBe('ok');
    expect(diffTone(1000)).toBe('over');
    expect(diffTone(-1)).toBe('short');
  });

  it('close needs a count; the numpad edits whole pesos', () => {
    expect(canClose(null)).toBe(false);
    expect(canClose(0)).toBe(true);
    let c = 0;
    for (const k of ['1', '5', '0'] as const) c = applyPadKey(c, k);
    expect(c).toBe(15000);
    expect(applyPadKey(c, 'back')).toBe(1500);
  });
});

describe('expenses', () => {
  const ok = { description: ' Hielo ', payee: ' Proveedor ', amountCents: 25000, method: 'CASH' as const };
  it('validates concept, payee and a positive amount (first missing field wins)', () => {
    expect(validateExpense(ok)).toBeNull();
    expect(validateExpense({ ...ok, description: '  ' })).toBe('description');
    expect(validateExpense({ ...ok, payee: '' })).toBe('payee');
    expect(validateExpense({ ...ok, amountCents: 0 })).toBe('amount');
  });
  it('maps concepto -> description and trims', () => {
    expect(expenseBody(ok)).toEqual({ amount_cents: 25000, payee: 'Proveedor', description: 'Hielo', payment_method: 'CASH' });
  });
});

describe('close blocked by open tickets', () => {
  it('reads the count out of the server sentence', () => {
    expect(openTicketsCount('No se puede cerrar la caja: hay 3 cuentas abiertas pendientes. Ciérralas primero.', null)).toBe(3);
    expect(openTicketsCount('hay 1 cuenta abierta', null)).toBe(1);
    expect(openTicketsCount(undefined, 7)).toBe(7);
  });
});

describe('sessions history', () => {
  it('newest first, capped at 30', () => {
    const s = Array.from({ length: 40 }, (_, i) => ({ id: String(i), opened_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z` }));
    const out = recentSessions(s as never);
    expect(out).toHaveLength(30);
    expect(out[0].opened_at! >= out[29].opened_at!).toBe(true);
  });
});

describe('count by denomination', () => {
  const denoms: Denom[] = [
    { key: 'B500', cents: 50000, kind: 'BILL' },
    { key: 'B20', cents: 2000, kind: 'BILL' },
    { key: 'C20', cents: 2000, kind: 'COIN' },
    { key: 'C0.50', cents: 50, kind: 'COIN' },
  ];
  it('totalCents sums qty x face value and ignores unknown keys', () => {
    expect(totalCents({ B500: 2, B20: 1, C20: 3, 'C0.50': 1, ZZZ: 9 }, denoms)).toBe(100000 + 2000 + 6000 + 50);
    expect(totalCents({}, denoms)).toBe(0);
  });
  it('splitEnvelope = counted - left per key, zero rows dropped', () => {
    expect(splitEnvelope({ B500: 3, B20: 5 }, { B500: 1, B20: 5 })).toEqual({ B500: 2 });
    expect(splitEnvelope({ B500: 1 }, {})).toEqual({ B500: 1 });
  });
  it('leftExceedsKey finds the first row where left > counted', () => {
    expect(leftExceedsKey({ B500: 1 }, { B500: 2 })).toBe('B500');
    expect(leftExceedsKey({ B500: 2 }, { B500: 2 })).toBeNull();
    expect(leftExceedsKey({}, { B20: 1 })).toBe('B20');
  });
  it('clampTo lowers rows to the max and drops zeros', () => {
    expect(clampTo({ B500: 3, B20: 2 }, { B500: 1, B20: 5 })).toEqual({ B500: 1, B20: 2 });
    expect(clampTo({ B500: 3 }, {})).toEqual({});
    const same = { B500: 1 };
    expect(clampTo(same, { B500: 4 })).toBe(same);
  });
  it('toApi keeps only whole positive quantities', () => {
    expect(toApi({ B500: 2, B20: 0, C20: 1.5, 'C0.50': 3 })).toEqual([{ key: 'B500', qty: 2 }, { key: 'C0.50', qty: 3 }]);
  });
  it('parseQty: whole numbers only, empty is 0', () => {
    expect(parseQty('')).toBe(0);
    expect(parseQty(' 12 ')).toBe(12);
    expect(parseQty('1.5')).toBeNull();
    expect(parseQty('-3')).toBeNull();
    expect(parseQty('abc')).toBeNull();
    expect(parseQty('123456789')).toBe(1234567);
  });
  it('canCloseCounted: left within counted, note required when left total != fund target', () => {
    const counted = { B500: 4, B20: 5 }; // 210000
    expect(canCloseCounted(counted, { B500: 4 }, 200000, '', denoms)).toEqual({ ok: true });
    expect(canCloseCounted(counted, { B500: 3 }, 200000, '', denoms)).toEqual({ ok: false, reason: 'NOTE_REQUIRED' });
    expect(canCloseCounted(counted, { B500: 3 }, 200000, '  ', denoms)).toEqual({ ok: false, reason: 'NOTE_REQUIRED' });
    expect(canCloseCounted(counted, { B500: 3 }, 200000, 'gasto pendiente', denoms)).toEqual({ ok: true });
    expect(canCloseCounted(counted, { B500: 5 }, 200000, 'x', denoms)).toEqual({ ok: false, reason: 'LEFT_EXCEEDS' });
  });
});
