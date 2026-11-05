import { useNetInfo } from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useConnectionStore, type ConnectionState } from '../realtime/socket';
import type { ConnLevel } from '../theme/tokens';

/** Pure: combine socket state and OS reachability (the socket alone is not enough, D8). */
export function connectionLevel(socket: ConnectionState, netOnline: boolean): ConnLevel {
  if (!netOnline) return 'offline';
  if (socket === 'connected') return 'online';
  if (socket === 'disconnected') return 'offline';
  return 'reconnecting';
}

export function useConnectionLevel(): ConnLevel {
  const socket = useConnectionStore((s) => s.state);
  const net = useNetInfo();
  const online = net.isConnected !== false && net.isInternetReachable !== false;
  return connectionLevel(socket, online);
}

/** Epoch ms of the freshest cached query (or last socket connect). null = nothing loaded yet. */
export function useLastUpdated(): number | null {
  const qc = useQueryClient();
  const lastConnected = useConnectionStore((s) => s.lastConnectedAt);
  const cacheStamp = useSyncExternalStore(
    (cb) => qc.getQueryCache().subscribe(cb),
    () => qc.getQueryCache().getAll().reduce((m, q) => Math.max(m, q.state.dataUpdatedAt), 0),
  );
  const best = Math.max(cacheStamp, lastConnected ?? 0);
  return best > 0 ? best : null;
}
