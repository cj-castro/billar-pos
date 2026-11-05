import { useEffect, useState } from 'react';

/** Elapsed seconds -> "mm:ss" or "h:mm:ss" (same output as web useTimer). */
export function formatElapsed(totalSeconds: number): string {
  const diff = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Elapsed since an ISO timestamp, formatted. Empty string when unparsable. */
export function elapsedSince(startIso: string | undefined | null, now: number = Date.now()): string {
  if (!startIso) return '';
  const start = new Date(startIso).getTime();
  if (Number.isNaN(start)) return '';
  return formatElapsed((now - start) / 1000);
}

/** Ticking hook (1 s). Cosmetic only: amounts are server-authoritative (D3). */
export function useElapsed(startIso: string | undefined | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startIso) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [startIso]);
  return elapsedSince(startIso, now);
}
