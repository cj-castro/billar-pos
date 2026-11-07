import type { CashSummaryResponse } from '../../api/endpoints/cash';
import type { OpenTicketRow } from '../../api/endpoints/managerTickets';
import type { CashStatus, QueueItem, Ticket } from '../../domain/types';
import { kds } from '../../theme/tokens';
import type { PrintFailure } from './printFailures';

/** Raw inputs; `undefined` = that endpoint failed or has not loaded (tile shows "—", never a fake 0). */
export interface OverviewInput {
  cash?: CashStatus;
  openAll?: readonly OpenTicketRow[];
  pending?: readonly Pick<Ticket, 'id'>[];
  counts?: { kitchen: number; bar: number };
  kitchenQueue?: readonly QueueItem[];
  barQueue?: readonly QueueItem[];
  printFailures?: readonly PrintFailure[];
  /** GET /cash/current/summary: `null` = no open session (404), `undefined` = failed / not loaded. */
  summary?: CashSummaryResponse | null;
  /** Rows of today's /reports/voids; undefined = unknown (no alert). */
  voidsToday?: number;
}

export interface OverviewStats {
  cashOpen: boolean | null;
  cashOpenedAt: string | null;
  fundCents: number | null;
  openTickets: number | null;
  openTotalCents: number | null;
  billRequested: number | null;
  kitchenCount: number | null;
  barCount: number | null;
  ghost: number | null;
  /** ISO sent_at of the oldest SENT/IN_PROGRESS item across both stations; null = none (or unknown). */
  oldestSentAt: string | null;
  /** Session sales; closed register = 0, failed = null. */
  salesCents: number | null;
  cashSalesCents: number | null;
  cardSalesCents: number | null;
  tipsCents: number | null;
}

const waiting = (i: QueueItem) => i.status === 'SENT' || i.status === 'IN_PROGRESS';
const time = (iso: string | null | undefined) => {
  const n = iso ? new Date(iso).getTime() : NaN;
  return Number.isNaN(n) ? null : n;
};

/** Oldest sent_at among items still waiting for the kitchen/bar (READY ones wait for the waiter, not the cook). */
export function oldestWaiting(...queues: (readonly QueueItem[] | undefined)[]): string | null {
  let best: number | null = null;
  for (const q of queues) {
    for (const i of q ?? []) {
      const n = waiting(i) ? time(i.sent_at) : null;
      if (n != null && (best == null || n < best)) best = n;
    }
  }
  return best == null ? null : new Date(best).toISOString();
}

const money = (s: CashSummaryResponse | null | undefined, pick: (x: CashSummaryResponse['summary']) => number) => (s === undefined ? null : s === null ? 0 : pick(s.summary));

export function aggregateOverview(inp: OverviewInput): OverviewStats {
  const queuesKnown = inp.kitchenQueue !== undefined || inp.barQueue !== undefined;
  return {
    cashOpen: inp.cash ? inp.cash.open : null,
    cashOpenedAt: inp.cash?.session?.opened_at ?? null,
    fundCents: inp.cash?.session ? inp.cash.session.opening_fund_cents : null,
    openTickets: inp.openAll ? inp.openAll.length : (inp.cash?.open_tickets_count ?? null),
    openTotalCents: inp.openAll ? inp.openAll.reduce((sum, t) => sum + (t.total_cents || 0), 0) : null,
    billRequested: inp.pending ? inp.pending.length : null,
    kitchenCount: inp.counts ? inp.counts.kitchen : null,
    barCount: inp.counts ? inp.counts.bar : null,
    ghost: inp.cash ? inp.cash.ghost_tickets_count : null,
    oldestSentAt: queuesKnown ? oldestWaiting(inp.kitchenQueue, inp.barQueue) : null,
    salesCents: money(inp.summary, (x) => x.total_sales_cents),
    cashSalesCents: money(inp.summary, (x) => x.cash_sales_cents),
    cardSalesCents: money(inp.summary, (x) => x.card_sales_cents),
    tipsCents: money(inp.summary, (x) => x.total_tips_cents),
  };
}

export type AlertKind = 'cash_closed' | 'old_items' | 'ghost' | 'print_failed' | 'old_tickets' | 'cash_closed_open' | 'voids';

/** Tickets open longer than this raise an alert (DESIGN_SPEC_V2 4.1). */
export const OLD_TICKET_MIN = 120;
/** Voids today at or above this raise an alert. */
export const VOIDS_ALERT_MIN = 3;

export interface OverviewAlert {
  id: string;
  kind: AlertKind;
  severity: 'warning' | 'alert';
  count?: number;
  minutes?: number;
  detail?: string | null;
  /** Print failures can be dismissed. */
  failureId?: string;
}

/** Items waiting longer than this are an alert (tokens.kds.alertAfterMin = 20). */
export const OLD_ITEM_MIN = kds.alertAfterMin;

export function deriveAlerts(stats: OverviewStats, inp: OverviewInput, nowMs: number): OverviewAlert[] {
  const alerts: OverviewAlert[] = [];
  if (stats.cashOpen === false) alerts.push({ id: 'cash_closed', kind: 'cash_closed', severity: 'warning' });

  let old = 0;
  let oldest = 0;
  for (const i of [...(inp.kitchenQueue ?? []), ...(inp.barQueue ?? [])]) {
    const sent = waiting(i) ? time(i.sent_at) : null;
    if (sent == null) continue;
    const min = (nowMs - sent) / 60000;
    if (min > OLD_ITEM_MIN) {
      old += 1;
      oldest = Math.max(oldest, min);
    }
  }
  if (old > 0) alerts.push({ id: 'old_items', kind: 'old_items', severity: 'alert', count: old, minutes: Math.floor(oldest) });

  if ((stats.ghost ?? 0) > 0) alerts.push({ id: 'ghost', kind: 'ghost', severity: 'warning', count: stats.ghost ?? 0 });

  const oldTickets = (inp.openAll ?? []).filter((t) => {
    const at = time(t.opened_at);
    return at != null && (nowMs - at) / 60000 > OLD_TICKET_MIN;
  }).length;
  if (oldTickets > 0) alerts.push({ id: 'old_tickets', kind: 'old_tickets', severity: 'warning', count: oldTickets });

  if (stats.cashOpen === false && (stats.openTickets ?? 0) > 0) alerts.push({ id: 'cash_closed_open', kind: 'cash_closed_open', severity: 'alert', count: stats.openTickets ?? 0 });

  if ((inp.voidsToday ?? 0) >= VOIDS_ALERT_MIN) alerts.push({ id: 'voids', kind: 'voids', severity: 'warning', count: inp.voidsToday });

  for (const f of inp.printFailures ?? [])
    alerts.push({ id: `print-${f.id}`, kind: 'print_failed', severity: 'alert', detail: f.error, failureId: f.id });

  return alerts;
}
