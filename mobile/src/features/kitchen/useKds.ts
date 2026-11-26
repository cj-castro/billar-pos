import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getQueue } from '../../api/endpoints/queue';
import { qk } from '../../api/queryKeys';
import { useConnectionLevel } from '../../components/connection';
import { useToast } from '../../components/Toast';
import type { LineItemStatus, QueueItem, Station } from '../../domain/types';
import { haptic } from '../../utils/haptics';
import { errorMessage } from '../../utils/errorMessage';
import { advanceAllReady, advanceItem, revertItems, revertSet, type AdvanceResult } from './kdsActions';
import { groupQueue, newItemIds, nextStatus, pendingCount } from './kdsModel';

/** Socket events trigger invalidation (realtime/socket.ts); this poll is the safety net when the socket is down. */
export const KDS_POLL_MS = 15_000;
export const STALE_AFTER_MS = 15_000;
export const FRESH_MS = 6_000;

export function useKdsQueue(station: Station) {
  const { t } = useTranslation('mobile');
  const q = useQuery({
    queryKey: qk.queue(station),
    queryFn: () => getQueue(station),
    refetchInterval: KDS_POLL_MS,
    staleTime: 5_000,
  });
  const noTable = t('kitchen.noTable');
  const items = q.data;
  const groups = useMemo(() => groupQueue(items ?? [], noTable), [items, noTable]);
  return { ...q, items: items ?? [], groups, pending: pendingCount(items ?? []) };
}

/** True when the socket/network has been down for more than `afterMs` (stale warning). */
export function useStaleLive(afterMs = STALE_AFTER_MS): boolean {
  const level = useConnectionLevel();
  const [stale, setStale] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setStale(level !== 'online'), level === 'online' ? 0 : afterMs);
    return () => clearTimeout(id);
  }, [level, afterMs]);
  return stale;
}

/**
 * Ids that appeared since the previous data (not on first load), highlighted for FRESH_MS with a haptic.
 * Derived-state-in-render (React docs pattern) so no synchronous setState in an effect.
 */
export function useFreshIds(items: readonly QueueItem[] | undefined): ReadonlySet<string> {
  const [prev, setPrev] = useState(items);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  if (items !== prev) {
    setPrev(items);
    if (prev && items) {
      const added = newItemIds(prev, items);
      if (added.length) setFresh(new Set([...fresh, ...added]));
    }
  }
  const size = fresh.size;
  useEffect(() => {
    if (!size) return;
    haptic.warning();
    const id = setTimeout(() => setFresh(new Set()), FRESH_MS);
    return () => clearTimeout(id);
  }, [fresh, size]);
  return fresh;
}

/** Item/ticket actions with optimistic updates, rollback, toasts and haptics. */
export function useKdsActions(station: Station, items: readonly QueueItem[]) {
  const { t } = useTranslation('mobile');
  const qc = useQueryClient();
  const toast = useToast();
  const level = useConnectionLevel();
  const [busy, setBusy] = useState<readonly string[]>([]);
  const offline = level === 'offline';

  const settle = useCallback(
    (results: AdvanceResult[]) => {
      const failed = results.filter((r) => !r.ok);
      if (failed.some((r) => !r.ok && r.voided)) {
        haptic.error();
        toast.show({ tone: 'warning', title: t('kitchen.voided'), message: t('kitchen.voidedHint') });
      }
      const real = failed.find((r) => !r.ok && !r.voided);
      if (real && !real.ok) {
        haptic.error();
        toast.show({ tone: 'error', title: t('kitchen.advanceFailed'), message: errorMessage(real.error) });
      }
      if (!failed.length) haptic.medium();
      if (failed.length) qc.invalidateQueries({ queryKey: qk.queue(station) });
    },
    [qc, station, t, toast],
  );

  const run = useCallback(
    async (ids: readonly string[], job: () => Promise<AdvanceResult[]>): Promise<AdvanceResult[] | undefined> => {
      if (offline) {
        toast.show({ tone: 'warning', title: t('kitchen.offlineAdvance') });
        return;
      }
      if (ids.some((id) => busy.includes(id))) return; // double tap while in flight
      setBusy((b) => [...b, ...ids]);
      try {
        const results = await job();
        settle(results);
        return results;
      } finally {
        setBusy((b) => b.filter((id) => !ids.includes(id)));
      }
    },
    [busy, offline, settle, t, toast],
  );

  /** 3 s snackbar after READY: "Deshacer" PATCHes the lines back to IN_PROGRESS. */
  const offerUndo = useCallback(
    (ids: readonly string[], results: AdvanceResult[] | undefined) => {
      const undo = results ? revertSet(ids, results) : [];
      if (!undo.length) return;
      toast.show({
        tone: 'success',
        title: t('kitchen.markedReady'),
        durationMs: 3000,
        action: {
          label: t('kitchen.undo'),
          onPress: () => {
            void revertItems(qc, station, undo).then((r) => {
              if (r === 'served') toast.show({ tone: 'info', title: t('kitchen.alreadyServed') });
              else if (r === 'failed') toast.show({ tone: 'error', title: t('kitchen.undoFailed') });
            });
          },
        },
      });
    },
    [qc, station, t, toast],
  );

  const advance = useCallback(
    async (itemId: string) => {
      const item = items.find((i) => i.id === itemId);
      const to = item ? nextStatus(item.status) : null;
      if (!item || !to) return;
      const results = await run([itemId], async () => [await advanceItem(qc, station, item, to)]);
      if (to === 'READY') offerUndo([itemId], results);
    },
    [items, offerUndo, qc, run, station],
  );

  const ticketItems = useCallback((ticketId: string) => items.filter((i) => i.ticket_id === ticketId && (i.status === 'SENT' || i.status === 'IN_PROGRESS')), [items]);

  const allReady = useCallback(
    async (ticketId: string) => {
      const list = ticketItems(ticketId);
      const ids = list.map((i) => i.id);
      // advanceAllReady results follow the plan order = the order of non-READY items, which `list` already is
      const results = await run(ids, () => advanceAllReady(qc, station, list));
      offerUndo(ids, results);
    },
    [offerUndo, qc, run, station, ticketItems],
  );

  const serve = useCallback(
    (ticketId: string) => {
      const list = items.filter((i) => i.ticket_id === ticketId && i.status === 'READY');
      return run(list.map((i) => i.id), () => Promise.all(list.map((i) => advanceItem(qc, station, { id: i.id, status: 'READY' as LineItemStatus }, 'SERVED'))));
    },
    [items, qc, run, station],
  );

  /** SENT items in the ticket (the "Todo listo" confirmation counts them). */
  const notStarted = useCallback((ticketId: string) => items.filter((i) => i.ticket_id === ticketId && i.status === 'SENT').length, [items]);

  return { advance, allReady, serve, notStarted, busy, offline };
}
