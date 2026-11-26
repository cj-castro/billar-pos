import { create } from 'zustand';

/**
 * M6 / D-10: server-vs-device clock offset (serverNow - deviceNow, ms), median of the last samples taken from
 * the HTTP `Date` header (1 s resolution is plenty for a 5/10 min age colour). Feeds the KDS age badge + border.
 */
const SAMPLES = 7;
const samples: number[] = [];

export const useClockOffset = create<{ offsetMs: number }>(() => ({ offsetMs: 0 }));

/** `dateHeader` as sent by the server; `receivedAt` = Date.now() when the response arrived. */
export function recordServerDate(dateHeader: unknown, receivedAt = Date.now()) {
  if (typeof dateHeader !== 'string') return;
  const server = Date.parse(dateHeader);
  if (Number.isNaN(server)) return;
  samples.push(server - receivedAt);
  if (samples.length > SAMPLES) samples.shift();
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median !== useClockOffset.getState().offsetMs) useClockOffset.setState({ offsetMs: median });
}

/** Test helper. */
export function __resetClockSkew() {
  samples.length = 0;
  useClockOffset.setState({ offsetMs: 0 });
}
