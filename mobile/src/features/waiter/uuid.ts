import * as Crypto from 'expo-crypto';

/** UUID v4 used as the per-draft-line Idempotency-Key (matches [A-Za-z0-9_-]{1,64}). */
export function newKey(): string {
  try {
    const id = Crypto.randomUUID();
    if (id) return id;
  } catch {
    // fall through
  }
  // SEC-17: a silent Math.random fallback would hide a broken native module; only tests may use it.
  if (process.env.NODE_ENV !== 'test') throw new Error('Secure random UUID unavailable');
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
