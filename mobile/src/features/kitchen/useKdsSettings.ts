import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { getSetting } from '../../api/endpoints/settings';
import { qkKds } from '../../api/queryKeys';
import type { QueueItem } from '../../domain/types';
import { kds } from '../../theme/tokens';
import { playChime } from '../waiter/ready/readyAlerts';
import { useKdsPrefs } from './kdsPrefs';
import { newSentIds, resolveThresholds, type KdsThresholds } from './kdsModel';

function useRawSetting(key: string): string | null {
  // Any failure (403 for kitchen roles, offline) resolves to null -> caller falls back.
  const q = useQuery({
    queryKey: qkKds.setting(key),
    queryFn: async () => (await getSetting(key)).value ?? null,
    staleTime: 5 * 60_000,
    retry: false,
  });
  return q.data ?? null;
}

const TOKENS: KdsThresholds = { warnMin: kds.warnAfterMin, lateMin: kds.alertAfterMin };

export function useKdsThresholds(): KdsThresholds {
  const warn = useRawSetting('kds_warn_min');
  const late = useRawSetting('kds_late_min');
  return resolveThresholds(warn, late, TOKENS);
}

export const CHIME_DEBOUNCE_MS = 2000;

/** Chime once (debounced) when the station queue gains SENT lines that were not in the previous snapshot. */
/** `station` change = different queue: drop the snapshot so the swap itself never chimes. */
export function useNewTicketSound(items: readonly QueueItem[] | undefined, station?: string) {
  const serverOn = useRawSetting('kds_sound_enabled') !== 'false'; // fallback: on
  const muted = useKdsPrefs((s) => s.muted);
  const prev = useRef<readonly QueueItem[] | undefined>(undefined);
  const last = useRef(0);
  const prevStation = useRef(station);
  useEffect(() => {
    if (prevStation.current !== station) {
      prevStation.current = station;
      prev.current = undefined;
    }
    const before = prev.current;
    prev.current = items;
    if (!before || !items || !serverOn || muted) return; // first load never chimes
    if (newSentIds(before, items).length === 0) return;
    const now = Date.now();
    if (now - last.current < CHIME_DEBOUNCE_MS) return;
    last.current = now;
    void playChime();
  }, [items, station, serverOn, muted]);
}
