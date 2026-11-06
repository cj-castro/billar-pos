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
  };
}

export type AlertKind = 'cash_closed' | 'old_items' | 'ghost' | 'print_failed';

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

  for (const f of inp.printFailures ?? [])
    alerts.push({ id: `print-${f.id}`, kind: 'print_failed', severity: 'alert', detail: f.error, failureId: f.id });

  return alerts;
}
