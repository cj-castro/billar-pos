import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { onRealtimeEvent } from '../../realtime/socket';

/** Events that change what the manager screens show (cash, tickets, floor, queues). */
export const OPERATIONS_EVENTS = [
  'floor:update',
  'ticket:updated',
  'ticket:item_status',
  'kitchen:update',
  'kitchen:item_update',
  'bar:update',
  'bar:item_update',
  'pool:timer_voided',
] as const;

/**
 * Socket-driven refresh: any of `events` invalidates `keys` (debounced 400 ms so a burst = one refetch).
 * The 30 s refetchInterval on each query is the fallback when the socket is down.
 */
export function useRefreshOnEvents(keys: readonly (readonly unknown[])[], events: readonly string[] = OPERATIONS_EVENTS, debounceMs = 400) {
  const qc = useQueryClient();
  const sig = JSON.stringify(keys);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        for (const k of JSON.parse(sig) as unknown[][]) qc.invalidateQueries({ queryKey: k });
      }, debounceMs);
    };
    const offs = events.map((e) => onRealtimeEvent(e, fire));
    return () => {
      if (timer) clearTimeout(timer);
      offs.forEach((off) => off());
    };
  }, [qc, sig, events, debounceMs]);
}
