import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { health } from '../../api/endpoints/health';
import { getSetting, putSetting } from '../../api/endpoints/settings';
import { qk } from '../../api/queryKeys';

export interface HealthState {
  status: 'idle' | 'testing' | 'ok' | 'fail';
  /** Latency of the last successful probe. */
  ms: number | null;
  lastOkAt: number | null;
}

/** GET /health with latency. `probe()` is the "Probar conexión" button; runs once on mount. */
export function useHealthProbe(): { state: HealthState; probe: () => Promise<void> } {
  const [state, setState] = useState<HealthState>({ status: 'idle', ms: null, lastOkAt: null });

  const run = useCallback(async () => {
    const t0 = Date.now();
    try {
      await health();
      const now = Date.now();
      setState({ status: 'ok', ms: now - t0, lastOkAt: now });
    } catch {
      setState((s) => ({ ...s, status: 'fail', ms: null }));
    }
  }, []);

  const probe = useCallback(async () => {
    setState((s) => ({ ...s, status: 'testing' }));
    await run();
  }, [run]);

  useEffect(() => {
    const id = setTimeout(() => void run(), 0);
    return () => clearTimeout(id);
  }, [run]);

  return { state, probe };
}

export const SETTING_KEYS = ['kds_sound_enabled', 'print_bar_tickets'] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

/** Server defaults (settings.py _DEFAULTS), used only while loading. */
export const parseBool = (v: string | undefined) => v === 'true' || v === '1';

export function useServerSetting(key: SettingKey) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.settings(key), queryFn: () => getSetting(key) });
  const m = useMutation({
    mutationFn: (next: boolean) => putSetting(key, next ? 'true' : 'false'),
    onSuccess: (s) => qc.setQueryData(qk.settings(key), s),
  });
  return { query: q, mutation: m, value: q.data ? parseBool(q.data.value) : null };
}
