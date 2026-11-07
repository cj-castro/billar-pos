import { useNetInfo } from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { useConnectionStore, type ConnectionState } from '../realtime/socket';
import { computeOnline, usePosReachability } from '../realtime/connectivity';
import type { ConnLevel } from '../theme/tokens';

/** Pure: combine socket state and OS reachability (the socket alone is not enough, D8). */
export function connectionLevel(socket: ConnectionState, netOnline: boolean, posReachable = false): ConnLevel {
  if (!netOnline) return 'offline';
  if (socket === 'connected') return 'online';
  // Socket down but the POS answers /health: REST works, so mutations stay enabled (banner says "reconnecting").
  if (socket === 'disconnected') return posReachable ? 'reconnecting' : 'offline';
  return 'reconnecting';
}

export function useConnectionLevel(): ConnLevel {
  const socket = useConnectionStore((s) => s.state);
  const net = useNetInfo();
  const pos = usePosReachability((s) => s.reachable);
  // C1: internet reachability is irrelevant on a bar LAN; POS health OR socket decides.
  return connectionLevel(socket, computeOnline(net, pos, socket === 'connected'), pos === true);
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
