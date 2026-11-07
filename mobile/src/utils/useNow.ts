import { useEffect, useState } from 'react';

/** Ticking clock (ms). `override` pins it (tests); `enabled=false` stops the interval. */
export function useNow(override?: number, everyMs = 1000, enabled = true): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    if (override !== undefined || !enabled) return;
    const first = setTimeout(() => setT(Date.now()), 0); // refresh a stale value when (re)enabled
    const id = setInterval(() => setT(Date.now()), everyMs);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [override, everyMs, enabled]);
  return override ?? t;
}
