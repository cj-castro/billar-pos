import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';
import { onlineManager } from '@tanstack/react-query';
import axios from 'axios';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { getServerUrl, onServerUrlChange } from '../config/serverConfig';
import { useConnectionStore } from './socket';

/**
 * C1/F1: the bar LAN usually has NO internet, so "online" must never depend on internet reachability.
 * Online = the POS answers GET {base}/api/v1/health  OR  the socket is connected.
 * `null` = not probed yet (fall back to the link state alone, never to isInternetReachable).
 */
export const usePosReachability = create<{ reachable: boolean | null }>(() => ({ reachable: null }));

const PROBE_TIMEOUT_MS = 4000;
const PROBE_EVERY_MS = 20_000;

/** Pure. `net.isInternetReachable` is deliberately ignored (it means "internet", not "POS"). */
export function computeOnline(net: Pick<NetInfoState, 'isConnected'>, posReachable: boolean | null, socketConnected: boolean): boolean {
  if (socketConnected || posReachable === true) return true;
  if (net.isConnected === false || posReachable === false) return false;
  return true;
}

/** Point NetInfo's own reachability probe at the POS (also keeps `useNetInfo().isInternetReachable` meaningful). */
export function configureReachability(base: string | null) {
  if (!base) return;
  NetInfo.configure({
    reachabilityUrl: `${base}/api/v1/health`,
    reachabilityTest: async (res) => res.status === 200,
    reachabilityShortTimeout: 5000,
    reachabilityLongTimeout: 20_000,
    reachabilityRequestTimeout: 8000,
    useNativeReachability: false,
  });
}

export async function probePos(): Promise<boolean | null> {
  const base = getServerUrl();
  if (!base) {
    usePosReachability.setState({ reachable: null });
    return null;
  }
  let ok = false;
  try {
    const res = await axios.get(`${base}/api/v1/health`, { timeout: PROBE_TIMEOUT_MS, validateStatus: () => true });
    ok = res.status === 200;
  } catch {
    ok = false;
  }
  if (getServerUrl() === base) usePosReachability.setState({ reachable: ok });
  return ok;
}

/** Wire NetInfo + health probe + socket into TanStack's onlineManager. Returns the unsubscribe. */
export function startConnectivity(): () => void {
  let net: NetInfoState | null = null;
  const apply = () => {
    const socketUp = useConnectionStore.getState().state === 'connected';
    onlineManager.setOnline(computeOnline({ isConnected: net?.isConnected ?? null }, usePosReachability.getState().reachable, socketUp));
  };
  configureReachability(getServerUrl());
  void probePos();

  const offNet = NetInfo.addEventListener((s) => {
    net = s;
    apply();
    void probePos();
  });
  const offPos = usePosReachability.subscribe(apply);
  const offSock = useConnectionStore.subscribe(apply);
  const offUrl = onServerUrlChange((url) => {
    configureReachability(url);
    usePosReachability.setState({ reachable: null });
    void NetInfo.refresh();
    void probePos();
  });
  const appSub = AppState.addEventListener('change', (st) => {
    if (st === 'active') void probePos();
  });
  const timer = setInterval(() => void probePos(), PROBE_EVERY_MS);
  return () => {
    offNet();
    offPos();
    offSock();
    offUrl();
    appSub.remove();
    clearInterval(timer);
  };
}
