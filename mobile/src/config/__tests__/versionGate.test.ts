import { compareSemver, isBelowMin, parseSemver } from '../versionGate';
import { setServerInfo, updateRequired } from '../serverInfo';
import { APP_VERSION } from '../version';

describe('versionGate', () => {
  it('parses lenient semver', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemver('v1.2')).toEqual([1, 2, 0]);
    expect(parseSemver('1.2.3-beta.1')).toEqual([1, 2, 3]);
    expect(parseSemver('x')).toBeNull();
    expect(parseSemver(undefined)).toBeNull();
  });

  it('compares numerically, not lexically', () => {
    expect(compareSemver('1.10.0', '1.9.0')).toBe(1);
    expect(compareSemver('1.1.0', '1.1.0')).toBe(0);
    expect(compareSemver('1.0.9', '1.1.0')).toBe(-1);
    expect(compareSemver('1.0.0', 'nope')).toBeNull();
  });

  it('blocks only when the stated minimum is newer than the app', () => {
    expect(isBelowMin('1.2.0', '1.1.0')).toBe(true);
    expect(isBelowMin('1.1.0', '1.1.0')).toBe(false);
    expect(isBelowMin('1.0.0', '1.1.0')).toBe(false);
    expect(isBelowMin(undefined, '1.1.0')).toBe(false);
    expect(isBelowMin('garbage', '1.1.0')).toBe(false);
  });

  it('serverInfo: absent fields never block; a higher minimum does', () => {
    setServerInfo({ status: 'ok' });
    expect(updateRequired()).toBe(false);
    setServerInfo({ status: 'ok', min_mobile_version: '99.0.0', server_version: '3.0.0' });
    expect(updateRequired()).toBe(true);
    setServerInfo({ status: 'ok', min_mobile_version: APP_VERSION });
    expect(updateRequired()).toBe(false);
  });
});
