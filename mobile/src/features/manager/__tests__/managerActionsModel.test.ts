import type { Ticket } from '../../../domain/types';
import { buildPaymentEdit, buildTimerEdit, formFromTicket, managerActionFlags, parseClock, parsePesos, type PaymentForm } from '../managerActionsModel';

const tk = (over: Record<string, unknown> = {}): Ticket =>
  ({ id: 't1', status: 'OPEN', payment_type: 'CASH', tendered_cents: 20000, tip_cents: 1000, timer_sessions: [], available_promotions: [], ...over }) as unknown as Ticket;

describe('role / status gating (mirrors the server)', () => {
  it('WAITER and kitchen see nothing', () => {
    for (const r of ['WAITER', 'KITCHEN_STAFF', undefined]) expect(Object.values(managerActionFlags(tk(), r)).some(Boolean)).toBe(false);
  });
  it('OPEN: force close + promotions, no reopen / edit payment', () => {
    expect(managerActionFlags(tk(), 'MANAGER')).toMatchObject({ forceClose: true, promotions: true, reprint: true, reopen: false, editPayment: false, voidTimer: false, editTimer: false });
  });
  it('CLOSED: reopen + edit payment, no force close / promotions / timer', () => {
    expect(managerActionFlags(tk({ status: 'CLOSED' }), 'ADMIN')).toMatchObject({ reopen: true, editPayment: true, forceClose: false, promotions: false, reprint: true });
  });
  it('void timer needs a running timer; correct time needs any timer session on an OPEN ticket', () => {
    const running = tk({ timer_sessions: [{ id: 's', status: 'ACTIVE', start_time: '2026-11-05T20:00:00Z', end_time: null }] });
    const ended = tk({ timer_sessions: [{ id: 's', status: 'COMPLETED', start_time: '2026-11-05T20:00:00Z', end_time: '2026-11-05T21:00:00Z' }] });
    expect(managerActionFlags(running, 'MANAGER')).toMatchObject({ voidTimer: true, editTimer: true });
    expect(managerActionFlags(ended, 'MANAGER')).toMatchObject({ voidTimer: false, editTimer: true });
    expect(managerActionFlags(tk({ timer_sessions: [{ id: 's', status: 'CANCELLED', start_time: null, end_time: null }] }), 'MANAGER').editTimer).toBe(false);
  });
});

describe('payment edit diff', () => {
  const closed = tk({ status: 'CLOSED' });
  it('prefills from the ticket and an untouched form is "no changes"', () => {
    const f = formFromTicket(closed);
    expect(f).toMatchObject({ paymentType: 'CASH', tendered: '200.00', tip: '10.00', paymentType2: '', tipSource: '' });
    expect(buildPaymentEdit(closed, f)).toEqual({ ok: false, error: 'none' });
  });
  it('sends only what changed', () => {
    const f: PaymentForm = { ...formFromTicket(closed), paymentType: 'CARD', tip: '25' };
    expect(buildPaymentEdit(closed, f)).toEqual({ ok: true, body: { payment_type: 'CARD', tip_cents: 2500 } });
  });
  it('rejects garbage amounts, a mixed payment without its amount and a split that does not add up', () => {
    const f = formFromTicket(closed);
    expect(buildPaymentEdit(closed, { ...f, tendered: 'abc' })).toEqual({ ok: false, error: 'amount' });
    expect(buildPaymentEdit(closed, { ...f, paymentType2: 'CARD' })).toEqual({ ok: false, error: 'tendered2' });
    expect(buildPaymentEdit(closed, { ...f, tipSource: 'SPLIT', tipCash: '3', tipCard: '3' })).toEqual({ ok: false, error: 'split' });
    expect(buildPaymentEdit(closed, { ...f, tipSource: 'SPLIT', tipCash: '4', tipCard: '6' })).toEqual({ ok: true, body: { tip_source: 'SPLIT', tip_cash_cents: 400, tip_card_cents: 600 } });
  });
  it('parsePesos', () => {
    expect(parsePesos('150')).toBe(15000);
    expect(parsePesos('150,5')).toBe(15050);
    expect(parsePesos('')).toBeNull();
    expect(parsePesos('-1')).toBeNaN();
    expect(parsePesos('1.234')).toBeNaN();
  });
});

describe('timer correction', () => {
  // 2026-11-06 01:00Z = 19:00 on Nov 5 in Mexico
  const s = { id: 's', status: 'ACTIVE', start_time: '2026-11-06T01:00:00Z', end_time: null };
  it('validates HH:MM', () => {
    expect(parseClock('7:05')).toEqual({ h: 7, m: 5 });
    for (const bad of ['24:00', '12:60', '1230', 'ab:cd', '']) expect(parseClock(bad)).toBeNull();
  });
  it('builds venue-local naive timestamps on the session venue day', () => {
    expect(buildTimerEdit(s, '18:30', '')).toEqual({ ok: true, start_time: '2026-11-05T18:30:00' });
    expect(buildTimerEdit(s, '18:30', '20:15')).toEqual({ ok: true, start_time: '2026-11-05T18:30:00', end_time: '2026-11-05T20:15:00' });
  });
  it('an end at or before the start rolls past midnight', () => {
    expect(buildTimerEdit(s, '23:00', '01:30')).toEqual({ ok: true, start_time: '2026-11-05T23:00:00', end_time: '2026-11-06T01:30:00' });
  });
  it('flags the bad field', () => {
    expect(buildTimerEdit(s, 'x', '')).toEqual({ ok: false, error: 'start' });
    expect(buildTimerEdit(s, '10:00', '99:00')).toEqual({ ok: false, error: 'end' });
  });
});
