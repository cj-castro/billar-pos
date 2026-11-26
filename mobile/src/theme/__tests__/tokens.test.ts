import { ageStyle, colors, kds, kdsAgeLevel, lineStatusStyle, tableStatusStyle } from '../tokens';

describe('kdsAgeLevel', () => {
  it('uses the token thresholds', () => {
    expect([kds.warnAfterMin, kds.alertAfterMin]).toEqual([10, 20]);
  });
  it.each([
    [0, 'neutral'],
    [9.99, 'neutral'],
    [10, 'warn'],
    [15, 'warn'],
    [20, 'warn'],
    [20.01, 'alert'],
    [95, 'alert'],
  ])('%p min -> %s', (m, level) => {
    expect(kdsAgeLevel(m)).toBe(level);
  });
  it('treats NaN / negative as neutral', () => {
    expect(kdsAgeLevel(NaN)).toBe('neutral');
    expect(kdsAgeLevel(-5)).toBe('neutral');
  });
  it('maps levels to the design colours', () => {
    expect(ageStyle('alert')).toMatchObject({ fg: colors.ageAlertFg, bg: colors.ageAlertBg, borderWidth: 2 });
    expect(ageStyle('neutral').borderWidth).toBe(1);
  });
});

describe('status styles', () => {
  it('table states carry colour + icon + label key', () => {
    expect(tableStatusStyle('BILL_REQUESTED')).toMatchObject({ icon: 'bell-outline', labelKey: 'status.table.BILL_REQUESTED', fg: colors.tableBillFg });
  });
  it('voided lines are struck through', () => {
    expect(lineStatusStyle('VOIDED').strike).toBe(true);
    expect(lineStatusStyle('READY').strike).toBeUndefined();
  });
});
