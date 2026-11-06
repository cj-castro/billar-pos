import type { QueryClient } from '@tanstack/react-query';
import { toApiError } from '../../api/client';
import { updateStatus, type QueueTargetStatus } from '../../api/endpoints/queue';
import { qk } from '../../api/queryKeys';
import type { LineItemStatus, QueueItem, Station } from '../../domain/types';
import { allReadyPlan, canTransition } from './kdsModel';

export interface KdsApi {
  updateStatus: (itemId: string, status: QueueTargetStatus, expectedFrom?: string) => Promise<unknown>;
}
const defaultApi: KdsApi = { updateStatus };

export type AdvanceResult = { ok: true } | { ok: false; voided: boolean; error: unknown };

function patch(qc: QueryClient, station: Station, id: string, status: LineItemStatus) {
  qc.setQueryData<QueueItem[]>(qk.queue(station), (old) => old?.map((i) => (i.id === id ? { ...i, status } : i)));
}
function remove(qc: QueryClient, station: Station, id: string) {
  qc.setQueryData<QueueItem[]>(qk.queue(station), (old) => old?.filter((i) => i.id !== id));
}

/**
 * One optimistic step for one item. Rolls back only THAT item on failure (parallel items keep their own
 * optimistic state); 409 ITEM_VOIDED removes the item instead (B3). Illegal transitions never hit the network.
 */
export async function advanceItem(
  qc: QueryClient,
  station: Station,
  item: { id: string; status: LineItemStatus },
  to: QueueTargetStatus,
  api: KdsApi = defaultApi,
): Promise<AdvanceResult> {
  if (!canTransition(item.status, to)) return { ok: false, voided: false, error: new Error('INVALID_TRANSITION') };
  await qc.cancelQueries({ queryKey: qk.queue(station) });
  patch(qc, station, item.id, to); // optimistic (SERVED = gone from the queue)
  if (to === 'SERVED') remove(qc, station, item.id);
  try {
    await api.updateStatus(item.id, to);
    return { ok: true };
  } catch (e) {
    const err = toApiError(e);
    if (err.status === 409 && err.code === 'ITEM_VOIDED') {
      remove(qc, station, item.id);
      return { ok: false, voided: true, error: err };
    }
    // rollback this item only; a SERVED removal is undone by the refetch the caller triggers
    patch(qc, station, item.id, item.status);
    return { ok: false, voided: false, error: err };
  }
}

/** "Todo listo": per item sequential steps (SENT -> IN_PROGRESS -> READY), items in parallel. */
export async function advanceAllReady(
  qc: QueryClient,
  station: Station,
  items: readonly { id: string; status: LineItemStatus }[],
  api: KdsApi = defaultApi,
): Promise<AdvanceResult[]> {
  return Promise.all(
    allReadyPlan(items).map(async ({ id, steps }) => {
      let status = items.find((i) => i.id === id)!.status;
      let last: AdvanceResult = { ok: true };
      for (const step of steps) {
        last = await advanceItem(qc, station, { id, status }, step, api);
        if (!last.ok) break;
        status = step;
      }
      return last;
    }),
  );
}

/** Ids to send back to IN_PROGRESS after "Listo"/"Todo listo": only the ones whose steps all succeeded. `results` is aligned with `ids`. */
export function revertSet(ids: readonly string[], results: readonly { ok: boolean }[]): string[] {
  return ids.filter((_, i) => results[i]?.ok);
}

/** Undo: READY -> IN_PROGRESS (the client forbids going backwards, so this bypasses canTransition on purpose). Sends expected_from=READY; 409 STATUS_CHANGED = already served. Rolls back on failure. */
export async function revertItems(qc: QueryClient, station: Station, ids: readonly string[], api: KdsApi = defaultApi): Promise<'ok' | 'served' | 'failed'> {
  await qc.cancelQueries({ queryKey: qk.queue(station) });
  ids.forEach((id) => patch(qc, station, id, 'IN_PROGRESS'));
  const res = await Promise.allSettled(ids.map((id) => api.updateStatus(id, 'IN_PROGRESS', 'READY')));
  res.forEach((r, i) => r.status === 'rejected' && patch(qc, station, ids[i], 'READY'));
  if (res.every((r) => r.status === 'fulfilled')) return 'ok';
  void qc.invalidateQueries({ queryKey: qk.queue(station) });
  return res.some((r) => r.status === 'rejected' && toApiError(r.reason).code === 'STATUS_CHANGED') ? 'served' : 'failed';
}
