import { toApiError } from '../../../api/client';
import type { DraftErrorCode, DraftLine } from './draftStore';

/**
 * Pure send orchestrator (SCREEN_STATE_MATRIX W-05, ACCEPTANCE US-W-08). No React, no store, no axios:
 * everything external comes in through `deps`/`onUpdate`, so every outcome is unit-testable.
 *
 * Guarantees: lines are posted one at a time, each with its own Idempotency-Key (the draft line key, never
 * regenerated) and the latest X-Ticket-Version. A line is never posted again after a confirmed 2xx, and an
 * ambiguous failure (timeout / 5xx / VERSION_CONFLICT without B1) is retried only with the SAME key.
 */
export interface SendLine {
  key: string;
  menuItemId: string;
  quantity: number;
  modifiers: { id: string }[];
  notes: string;
}

export interface AddItemBodyDep {
  menu_item_id: string;
  quantity: number;
  modifiers?: { modifier_id: string }[];
  notes?: string;
}

export interface SendDeps {
  addItem: (
    ticketId: string,
    body: AddItemBodyDep,
    opts: { idempotencyKey: string; ticketVersion?: number },
  ) => Promise<{ ticket_version?: number } | undefined | null>;
  /** Fresh ticket.version (refetch). null when it cannot be read. */
  fetchVersion: (ticketId: string) => Promise<number | null>;
}

export type LinePatch =
  | { state: 'SENDING' }
  | { state: 'SENT' }
  | { state: 'PENDING' }
  | { state: 'FAILED'; error: DraftErrorCode; errorDetail?: string };

export type StopReason = 'closed' | 'unauthorized' | 'network' | 'verify';

export interface SendResult {
  sent: string[];
  failed: string[];
  /** Why the loop stopped early (null = every line was attempted). */
  stopped: StopReason | null;
  /** The server returned `ticket_version` (backend extension B1 deployed). */
  b1: boolean;
  version: number | null;
}

export interface SendParams {
  ticketId: string;
  lines: SendLine[];
  /** Latest known ticket.version. */
  version: number | null;
  /** B1 seen earlier in this app session. */
  b1Known?: boolean;
  deps: SendDeps;
  onUpdate: (key: string, patch: LinePatch) => void;
}

/** Server text is only a detail when it says something (toApiError's generic fallback is not). */
const detailOf = (message: string) => (!message || /^Request failed \(\d+\)$/.test(message) ? undefined : message);

export async function sendDraft({ ticketId, lines, version: initial, b1Known = false, deps, onUpdate }: SendParams): Promise<SendResult> {
  let version = initial;
  let b1 = b1Known;
  const sent: string[] = [];
  const failed: string[] = [];

  const refresh = async () => {
    try {
      version = await deps.fetchVersion(ticketId);
    } catch {
      version = null; // no lock header; the server still protects stock/ticket state
    }
  };

  for (const line of lines) {
    onUpdate(line.key, { state: 'SENDING' });
    let conflictRetried = false;
    for (;;) {
      try {
        const res = await deps.addItem(
          ticketId,
          {
            menu_item_id: line.menuItemId,
            quantity: line.quantity,
            ...(line.modifiers.length ? { modifiers: line.modifiers.map((m) => ({ modifier_id: m.id })) } : {}),
            ...(line.notes ? { notes: line.notes } : {}),
          },
          { idempotencyKey: line.key, ...(version != null ? { ticketVersion: version } : {}) },
        );
        if (typeof res?.ticket_version === 'number') {
          b1 = true;
          version = res.ticket_version;
        } else {
          await refresh(); // no B1: the version moved, read it back before the next line
        }
        sent.push(line.key);
        onUpdate(line.key, { state: 'SENT' });
        break;
      } catch (e) {
        const err = toApiError(e);

        if (err.status === 409 && err.code === 'VERSION_CONFLICT') {
          await refresh();
          if (b1 && !conflictRetried) {
            conflictRetried = true;
            continue; // same key: B1 makes a replay safe
          }
          // Without B1 the first attempt might have landed: let the waiter check the ticket first.
          failed.push(line.key);
          onUpdate(line.key, { state: 'FAILED', error: 'VERIFY' });
          return { sent, failed, stopped: 'verify', b1, version };
        }
        if ((err.status === 403 && err.code === 'TICKET_CLOSED') || err.status === 404 || (err.status === 409 && err.code === 'TICKET_NOT_OPEN')) {
          onUpdate(line.key, { state: 'PENDING' });
          return { sent, failed, stopped: 'closed', b1, version };
        }
        if (err.status === 401) {
          onUpdate(line.key, { state: 'PENDING' });
          return { sent, failed, stopped: 'unauthorized', b1, version };
        }
        if (err.status === 422 || err.status === 400) {
          const error: DraftErrorCode =
            err.code === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : err.code === 'FLAVOR_REQUIRED' ? 'FLAVOR_REQUIRED' : err.code === 'INVALID_QUANTITY' ? 'INVALID_QUANTITY' : 'UNKNOWN';
          failed.push(line.key);
          onUpdate(line.key, { state: 'FAILED', error, errorDetail: detailOf(err.message) });
          break; // this line is dead until edited; the others go on
        }
        if (err.isNetwork || err.isTimeout || (err.status ?? 0) >= 500) {
          // Outcome unknown. Keep the key; remaining lines stay untouched (they would fail the same way).
          failed.push(line.key);
          onUpdate(line.key, { state: 'FAILED', error: err.isNetwork || err.isTimeout ? 'NETWORK' : 'SERVER' });
          return { sent, failed, stopped: 'network', b1, version };
        }
        failed.push(line.key);
        onUpdate(line.key, { state: 'FAILED', error: 'UNKNOWN', errorDetail: detailOf(err.message) });
        break;
      }
    }
  }
  return { sent, failed, stopped: null, b1, version };
}

// ---------------------------------------------------------------- selectors
/** Lines a global "Enviar / Reintentar" posts: fresh ones + transient failures. Dead lines (stock, flavor, verify) need the waiter. */
export function sendableLines(lines: readonly DraftLine[]): DraftLine[] {
  return lines.filter((l) => l.state === 'PENDING' || (l.state === 'FAILED' && (l.error === 'NETWORK' || l.error === 'SERVER')));
}

export const isSending = (lines: readonly DraftLine[]) => lines.some((l) => l.state === 'SENDING');
export const failedLines = (lines: readonly DraftLine[]) => lines.filter((l) => l.state === 'FAILED');
