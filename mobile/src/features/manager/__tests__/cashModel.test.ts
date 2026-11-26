import { applyPadKey, canClose, cashDifference, diffTone, expenseBody, openTicketsCount, recentSessions, validateExpense } from '../cash/cashModel';

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
