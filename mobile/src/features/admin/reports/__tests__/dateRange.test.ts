import { addDays, isValidYmd, mexicoToday, rangeFor } from '../dateRange';

describe('dateRange', () => {
  it('mexicoToday uses Mexico local date, not UTC', () => {
    // 03:00 UTC on the 6th is still the 5th (21:00) in Mexico City.
    expect(mexicoToday(new Date('2026-11-06T03:00:00Z'))).toBe('2026-11-05');
    expect(mexicoToday(new Date('2026-11-06T15:00:00Z'))).toBe('2026-11-06');
  });

  it('presets', () => {
    const today = '2026-11-06'; // Friday
    expect(rangeFor('today', today)).toEqual({ from: today, to: today });
    expect(rangeFor('yesterday', today)).toEqual({ from: '2026-11-05', to: '2026-11-05' });
    expect(rangeFor('week', today)).toEqual({ from: '2026-11-02', to: today }); // Monday
    expect(rangeFor('week', '2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-02' });
    expect(rangeFor('week', '2026-11-08')).toEqual({ from: '2026-11-02', to: '2026-11-08' }); // Sunday
    expect(rangeFor('month', today)).toEqual({ from: '2026-11-01', to: today });
  });

  it('custom range accepts valid, falls back to today when invalid or inverted', () => {
    const today = '2026-11-06';
    expect(rangeFor('range', today, { from: '2026-10-01', to: '2026-10-31' })).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(rangeFor('range', today, { from: '2026-10-31', to: '2026-10-01' })).toEqual({ from: today, to: today });
    expect(rangeFor('range', today, { from: 'x', to: today })).toEqual({ from: today, to: today });
    expect(rangeFor('range', today)).toEqual({ from: today, to: today });
  });

  it('addDays crosses month/year; isValidYmd rejects impossible dates', () => {
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(isValidYmd('2026-02-31')).toBe(false);
    expect(isValidYmd('2026-2-3')).toBe(false);
    expect(isValidYmd('2026-02-28')).toBe(true);
  });
});
