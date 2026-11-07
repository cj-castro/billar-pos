import type { PaymentFields, PromoOffer, TimerSession } from '../../api/endpoints/managerOps';
import type { Ticket } from '../../domain/types';
import { mexicoClock, mexicoDay } from './mexDate';

export const isManagerRole = (role: string | null | undefined) => role === 'MANAGER' || role === 'ADMIN';

export const timerSessions = (t: Pick<Ticket, 'timer_sessions'>): TimerSession[] => ((t.timer_sessions ?? []) as TimerSession[]).filter((s) => s && s.status !== 'CANCELLED');
/** The running timer (no end_time). */
export const activeTimer = (t: Pick<Ticket, 'timer_sessions'>): TimerSession | null => timerSessions(t).find((s) => !s.end_time) ?? null;
export const promoOffers = (t: Pick<Ticket, 'available_promotions'>): PromoOffer[] => (t.available_promotions ?? []) as PromoOffer[];
export const paymentFields = (t: Ticket): PaymentFields => t as unknown as PaymentFields;

export interface ManagerActionFlags {
  forceClose: boolean;
  reopen: boolean;
  editPayment: boolean;
  promotions: boolean;
  reprint: boolean;
  voidTimer: boolean;
  editTimer: boolean;
}

/** Which "Acciones de gerente" rows apply. Mirrors the server (OPEN/CLOSED guards); the server stays the authority. */
export function managerActionFlags(ticket: Ticket, role: string | null | undefined): ManagerActionFlags {
  const m = isManagerRole(role);
  const open = ticket.status === 'OPEN';
  const closed = ticket.status === 'CLOSED';
  return {
    forceClose: m && open,
    reopen: m && closed,
    editPayment: m && closed,
    promotions: m && open,
    reprint: m,
    voidTimer: m && open && activeTimer(ticket) !== null,
    editTimer: m && open && timerSessions(ticket).length > 0,
  };
}

// ------------------------------------------------------------------ edit payment
export type PayMethod = 'CASH' | 'CARD' | 'EXTERNAL';
export type TipSource = '' | 'CASH' | 'CARD' | 'SPLIT';
export interface PaymentForm {
  paymentType: PayMethod;
  tendered: string;
  tip: string;
  paymentType2: '' | 'CASH' | 'CARD';
  tendered2: string;
  tipSource: TipSource;
  tipCash: string;
  tipCard: string;
}

const pesos = (c: number | null | undefined) => (c == null ? '' : (c / 100).toFixed(2));
/** "150" / "150.5" / "150,50" -> cents; '' -> null; garbage / negative -> NaN. */
export function parsePesos(text: string): number | null {
  const v = text.trim().replace(',', '.');
  if (v === '') return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return NaN;
  return Math.round(Number(v) * 100);
}

export function formFromTicket(t: Ticket): PaymentForm {
  const p = paymentFields(t);
  const m = p.payment_type;
  return {
    paymentType: m === 'CARD' || m === 'EXTERNAL' ? m : 'CASH',
    tendered: pesos(p.tendered_cents),
    tip: pesos(p.tip_cents ?? 0),
    paymentType2: p.payment_type_2 === 'CASH' || p.payment_type_2 === 'CARD' ? p.payment_type_2 : '',
    tendered2: pesos(p.tendered_cents_2),
    tipSource: p.tip_source === 'CASH' || p.tip_source === 'CARD' || p.tip_source === 'SPLIT' ? p.tip_source : '',
    tipCash: pesos(p.tip_cash_cents),
    tipCard: pesos(p.tip_card_cents),
  };
}

export type PaymentEditError = 'amount' | 'tendered2' | 'split' | 'none';
export type PaymentEditResult = { ok: true; body: Record<string, unknown> } | { ok: false; error: PaymentEditError };

/** Only the fields that changed (the server answers 422 NO_CHANGES for an empty diff). */
export function buildPaymentEdit(t: Ticket, f: PaymentForm): PaymentEditResult {
  const o = paymentFields(t);
  const tendered = parsePesos(f.tendered);
  const tip = parsePesos(f.tip);
  const tendered2 = parsePesos(f.tendered2);
  const tipCash = parsePesos(f.tipCash);
  const tipCard = parsePesos(f.tipCard);
  if ([tendered, tip, tendered2, tipCash, tipCard].some((v) => Number.isNaN(v))) return { ok: false, error: 'amount' };
  if (f.paymentType2 && tendered2 == null) return { ok: false, error: 'tendered2' };
  if (f.tipSource === 'SPLIT' && (tipCash ?? 0) + (tipCard ?? 0) !== (tip ?? 0)) return { ok: false, error: 'split' };

  const body: Record<string, unknown> = {};
  const put = (key: string, next: unknown, prev: unknown) => {
    if ((next ?? null) !== (prev ?? null)) body[key] = next;
  };
  put('payment_type', f.paymentType, o.payment_type);
  put('tendered_cents', tendered, o.tendered_cents);
  put('tip_cents', tip ?? 0, o.tip_cents ?? 0);
  put('payment_type_2', f.paymentType2 || null, o.payment_type_2);
  put('tendered_cents_2', f.paymentType2 ? tendered2 : null, o.tendered_cents_2);
  put('tip_source', f.tipSource || null, o.tip_source);
  if (f.tipSource === 'SPLIT') {
    put('tip_cash_cents', tipCash ?? 0, o.tip_cash_cents);
    put('tip_card_cents', tipCard ?? 0, o.tip_card_cents);
  }
  return Object.keys(body).length ? { ok: true, body } : { ok: false, error: 'none' };
}

// ------------------------------------------------------------------ timer correction
export function parseClock(text: string): { h: number; m: number } | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

const hhmm = (c: { h: number; m: number }) => `${String(c.h).padStart(2, '0')}:${String(c.m).padStart(2, '0')}`;
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export type TimerEditResult = { ok: true; start_time: string; end_time?: string } | { ok: false; error: 'start' | 'end' };

/**
 * Venue-local HH:MM inputs -> naive ISO strings (the server reads naive as venue-local).
 * The date is the session venue day; an end at or before the start means "after midnight" (next day).
 * A blank end keeps the stored end (or leaves a running timer running).
 */
export function buildTimerEdit(session: TimerSession, startText: string, endText: string): TimerEditResult {
  const s = parseClock(startText);
  if (!s) return { ok: false, error: 'start' };
  const day = session.start_time ? mexicoDay(session.start_time) : mexicoDay(Date.now());
  const start_time = `${day}T${hhmm(s)}:00`;
  if (endText.trim() === '') return { ok: true, start_time };
  const e = parseClock(endText);
  if (!e) return { ok: false, error: 'end' };
  const endDay = hhmm(e) <= hhmm(s) ? nextDay(day) : day;
  return { ok: true, start_time, end_time: `${endDay}T${hhmm(e)}:00` };
}

export const timerFormDefaults = (s: TimerSession) => ({ start: mexicoClock(s.start_time), end: s.end_time ? mexicoClock(s.end_time) : '' });

/** i18n key (under mgr.actions.errors) for a server error code from these endpoints. */
export const actionErrorKey = (code: string): string | null =>
  ({
    CASH_SESSION_CLOSED: 'cashClosed',
    RESOURCE_OCCUPIED: 'occupied',
    RESOURCE_UNAVAILABLE: 'unavailable',
    ALREADY_OPEN: 'alreadyOpen',
    TICKET_NOT_OPEN: 'notOpen',
    TICKET_NOT_CLOSED: 'notClosed',
    NO_CHANGES: 'noChanges',
    REASON_REQUIRED: 'reason',
    NO_ACTIVE_TIMER: 'noTimer',
    INVALID_TIME_RANGE: 'timeRange',
    INVALID_TIMESTAMP: 'timeRange',
    PROMO_NOT_CONFIRMABLE: 'promoGone',
    PROMO_NOT_FOUND: 'promoGone',
    HTTP_503: 'printDown',
  })[code] ?? null;
