import { useState, useSyncExternalStore } from 'react';
import { useClockOffset } from '../../api/clockSkew';

/** ONE 1 s interval for every ticking tile on screen (floor timers, waiting list), started by the first subscriber. */
let tick = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

function subscribe(cb: () => void) {
  subs.add(cb);
  if (!timer) {
    tick = Date.now();
    timer = setInterval(() => {
      tick = Date.now();
      subs.forEach((f) => f());
    }, 1000);
  }
  return () => {
    subs.delete(cb);
    if (!subs.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}
const noop = () => () => {};

/** Server-corrected "now" (ms; `raw` = device clock, for deltas against device timestamps), re-rendering once a second. `enabled=false` subscribes to nothing. */
export function useSharedNow(enabled = true, raw = false): number {
  const offset = useClockOffset((s) => s.offsetMs);
  const live = useSyncExternalStore(enabled ? subscribe : noop, () => tick);
  // Disabled = frozen at the instant it was disabled (the global tick is stale when nobody subscribes).
  const [snap, setSnap] = useState(() => Date.now());
  if (enabled && snap !== live) setSnap(live);
  const t = enabled ? live : snap;
  return raw ? t : t + offset;
}
