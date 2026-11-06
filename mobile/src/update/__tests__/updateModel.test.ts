import { dueForCheck, isNewerBuild, parseLatest, CHECK_INTERVAL_MS } from '../updateModel';

const ok = { version: '1.2.0', build: 3, apk: 'bola8-staff-1.2.0-3.apk', notes: 'n', sha256: 'ab', md5: 'A'.repeat(32) };

describe('updateModel', () => {
  it('parses a valid latest.json (md5 lowercased, notes optional)', () => {
    expect(parseLatest({ ...ok, notes: undefined })).toEqual({ ...ok, notes: '', md5: 'a'.repeat(32) });
    expect(parseLatest({ ...ok, build: '4' })?.build).toBe(4);
  });
  it('rejects malformed input', () => {
    for (const bad of [null, 'x', {}, { ...ok, build: 1.5 }, { ...ok, build: 0 }, { ...ok, md5: 'zz' }, { ...ok, apk: '../x.apk' }, { ...ok, apk: '' }, { ...ok, version: 1 }]) {
      expect(parseLatest(bad)).toBeNull();
    }
  });
  it('compares builds as integers, not strings', () => {
    const l = parseLatest({ ...ok, build: 10 })!;
    expect(isNewerBuild(l, 9)).toBe(true);
    expect(isNewerBuild(l, 10)).toBe(false);
    expect(isNewerBuild(l, 11)).toBe(false);
  });
  it('throttles checks to once per 6 h', () => {
    const t = 1_000_000_000;
    expect(dueForCheck(null, t)).toBe(true);
    expect(dueForCheck(t - CHECK_INTERVAL_MS + 1, t)).toBe(false);
    expect(dueForCheck(t - CHECK_INTERVAL_MS, t)).toBe(true);
    expect(dueForCheck(t + 5, t)).toBe(true); // clock went backwards
  });
});
