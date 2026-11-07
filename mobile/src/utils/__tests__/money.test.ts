import { __manualFormat, formatMXN, formatMXNFromPesos } from '../money';
import { elapsedSince, formatElapsed } from '../time';

describe('money', () => {
  it('formats cents like the web POS', () => {
    expect(formatMXN(125200)).toBe('$1,252.00');
    expect(formatMXN(0)).toBe('$0.00');
    expect(formatMXN(5)).toBe('$0.05');
    expect(formatMXN(123456789)).toBe('$1,234,567.89');
    expect(formatMXN(null)).toBe('—');
    expect(formatMXN(undefined)).toBe('—');
    expect(formatMXNFromPesos(1252.5)).toBe('$1,252.50');
  });

  it('manual fallback matches the Intl format', () => {
    for (const v of [0, 0.05, 1252.5, 999999.99, -42.1]) {
      expect(__manualFormat(v)).toBe(v < 0 ? `-${formatMXNFromPesos(-v)}` : formatMXNFromPesos(v));
    }
  });
});

describe('time', () => {
  it('formats elapsed mm:ss and h:mm:ss', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65)).toBe('01:05');
    expect(formatElapsed(3600 + 61)).toBe('1:01:01');
    expect(formatElapsed(-5)).toBe('00:00');
  });

  it('elapsedSince handles bad input', () => {
    const now = Date.parse('2026-01-01T01:00:00Z');
    expect(elapsedSince('2026-01-01T00:58:30Z', now)).toBe('01:30');
    expect(elapsedSince(undefined, now)).toBe('');
    expect(elapsedSince('nope', now)).toBe('');
  });
});
