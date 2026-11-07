import { toApiError } from '../../../api/client';
import type { DraftErrorCode, DraftLine } from './draftStore';

/**
 * Pure send orchestrator (SCREEN_STATE_MATRIX W-05, ACCEPTANCE US-W-08). No React, no store, no axios:
 * everything external comes in through `deps`/`onUpdate`, so every outcome is unit-testable.
 *
 * Guarantees: lines are posted one at a time, each with its own Idempotency-Key (the draft line key, never
 * regenerated) and the latest X-Ticket-Version. A line is never posted again after a confirmed 2xx, and an
 * ambiguous failure (timeout / 5xx) is retried only with the SAME key.
 */
export interface SendLine {
  key: string;
  menuItemId: string;
  quantity: number;
  modifiers: { id: string }[];
  notes: string;
  /** X-Ticket-Version of this line's first POST (null = none sent); undefined = never attempted. */
  firstAttemptVersion?: number | null;
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
  | { state: 'SENDING'; firstAttemptVersion?: number | null }
  | { state: 'SENT' }
  | { state: 'PENDING' }
  /** Definitive server rejection: the line was NOT created, so it is a fresh line again (`resetAttempt`). */
  | { state: 'FAILED'; error: DraftErrorCode; errorDetail?: string; resetAttempt?: boolean };

export type StopReason = 'closed' | 'unauthorized' | 'network' | 'verify' | 'aborted';

export interface SendResult {
  sent: string[];
  failed: string[];
  /** Why the loop stopped early (null = every line was attempted). */
  stopped: StopReason | null;
  version: number | null;
}

export interface SendParams {
  ticketId: string;
  lines: SendLine[];
  /** Latest known ticket.version. */
  version: number | null;
  deps: SendDeps;
  onUpdate: (key: string, patch: LinePatch) => void;
  /**
   * Run binding (session/server/draft still the same, line still exists). Checked before every POST and after every
   * await, before any callback: once false the run ends silently (no POST, no onUpdate).
   */
  isLive?: (key: string) => boolean;
}

const ABORT = Symbol('send-aborted');

/** Server text is only a detail when it says something (toApiError's generic fallback is not). */
const detailOf = (message: string) => (!message || /^Request failed \(\d+\)$/.test(message) ? undefined : message);

export async function sendDraft(params: SendParams): Promise<SendResult> {
  const state = { sent: [] as string[], failed: [] as string[], version: params.version };
  try {
    return await run(params, state);
  } catch (e) {
    if (e !== ABORT) throw e;
    return { sent: state.sent, failed: state.failed, stopped: 'aborted', version: state.version };
  }
}

async function run(
  { ticketId, lines, version: initial, deps, onUpdate: rawUpdate, isLive }: SendParams,
  state: { sent: string[]; failed: string[]; version: number | null },
): Promise<SendResult> {
  const check = (key: string) => {
    if (isLive && !isLive(key)) throw ABORT;
  };
  let curKey = '';
  const onUpdate: SendParams['onUpdate'] = (k, p) => (check(k), rawUpdate(k, p));
  let version = initial;
  const { sent, failed } = state;

  const refresh = async () => {
    try {
      version = await deps.fetchVersion(ticketId);
    } catch {
      version = null; // no lock header; the server still protects stock/ticket state
    }
    check(curKey);
  };

  for (const line of lines) {
    curKey = line.key;
    check(line.key);
    // Earlier attempt of unknown outcome? Same key: the server replays it, whatever the version.
    const retryOfUncertain = line.firstAttemptVersion !== undefined;
    const attemptVersion = version;
    onUpdate(line.key, retryOfUncertain ? { state: 'SENDING' } : { state: 'SENDING', firstAttemptVersion: attemptVersion });
    let conflictRetried = false;
    let currentVersion = attemptVersion;
    for (;;) {
      check(line.key); // before EVERY POST (incl. the VERSION_CONFLICT retry)
      try {
        const res = await deps.addItem(
          ticketId,
          {
            menu_item_id: line.menuItemId,
            quantity: line.quantity,
            ...(line.modifiers.length ? { modifiers: line.modifiers.map((m) => ({ modifier_id: m.id })) } : {}),
            ...(line.notes ? { notes: line.notes } : {}),
          },
          { idempotencyKey: line.key, ...(currentVersion != null ? { ticketVersion: currentVersion } : {}) },
        );
        check(line.key); // response after invalidation: nothing may touch the store
        if (typeof res?.ticket_version === 'number') {
          version = res.ticket_version;
        } else {
          await refresh(); // response without ticket_version: the version moved, read it back before the next line
        }
        sent.push(line.key);
        onUpdate(line.key, { state: 'SENT' });
        break;
      } catch (e) {
        if (e === ABORT) throw e;
        check(line.key);
        const err = toApiError(e);

        if (err.status === 409 && err.code === 'VERSION_CONFLICT') {
          // Replay is decided before the version check, so refreshing and retrying with the same key is safe.
          if (!conflictRetried) {
            await refresh();
            currentVersion = version;
            conflictRetried = true;
            continue;
          }
          await refresh();
          failed.push(line.key);
          onUpdate(line.key, { state: 'FAILED', error: 'VERIFY' });
          return { sent, failed, stopped: 'verify', version };
        }
        if ((err.status === 403 && err.code === 'TICKET_CLOSED') || err.status === 404 || (err.status === 409 && err.code === 'TICKET_NOT_OPEN')) {
          onUpdate(line.key, { state: 'PENDING' });
          return { sent, failed, stopped: 'closed', version };
        }
        if (err.status === 401) {
          onUpdate(line.key, { state: 'PENDING' });
          return { sent, failed, stopped: 'unauthorized', version };
        }
        if (err.status === 422 || err.status === 400) {
          const error: DraftErrorCode =
            err.code === 'OUT_OF_STOCK' ? 'OUT_OF_STOCK' : err.code === 'FLAVOR_REQUIRED' ? 'FLAVOR_REQUIRED' : err.code === 'INVALID_QUANTITY' ? 'INVALID_QUANTITY' : 'UNKNOWN';
          failed.push(line.key);
          onUpdate(line.key, { state: 'FAILED', error, errorDetail: detailOf(err.message), resetAttempt: true });
          break; // this line is dead until edited; the others go on
        }
        if (err.isNetwork || err.isTimeout || (err.status ?? 0) >= 500) {
          // Outcome unknown. Keep the key; remaining lines stay untouched (they would fail the same way).
          failed.push(line.key);
          onUpdate(line.key, { state: 'FAILED', error: err.isNetwork || err.isTimeout ? 'NETWORK' : 'SERVER' });
          return { sent, failed, stopped: 'network', version };
        }
        failed.push(line.key);
        onUpdate(line.key, { state: 'FAILED', error: 'UNKNOWN', errorDetail: detailOf(err.message) });
        break;
      }
    }
  }
  return { sent, failed, stopped: null, version };
}

// ---------------------------------------------------------------- selectors
/** Lines a global "Enviar / Reintentar" posts: fresh ones + transient failures. Dead lines (stock, flavor, verify) need the waiter. */
export function sendableLines(lines: readonly DraftLine[]): DraftLine[] {
  return lines.filter((l) => l.state === 'PENDING' || (l.state === 'FAILED' && (l.error === 'NETWORK' || l.error === 'SERVER')));
}

export const isSending = (lines: readonly DraftLine[]) => lines.some((l) => l.state === 'SENDING');
export const failedLines = (lines: readonly DraftLine[]) => lines.filter((l) => l.state === 'FAILED');
