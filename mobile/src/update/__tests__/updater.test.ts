import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { checkForUpdate, downloadUpdate, launchInstaller, updatesConfigured } from '../updater';

let mockUpdates: Record<string, string> = {};
jest.mock('expo-constants', () => ({ __esModule: true, default: { get expoConfig() { return { extra: { updates: mockUpdates } }; } } }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const setOS = (os: string) => { (Platform as { OS: string }).OS = os; };
const mockLauncher = jest.fn();
jest.mock('expo-intent-launcher', () => ({ startActivityAsync: (...a: unknown[]) => mockLauncher(...a) }));
jest.mock('../../config/version', () => ({ APP_BUILD: 4 }));

const latest = { version: '1.2.0', build: 5, apk: 'bola8-staff-1.2.0-5.apk', notes: 'n', sha256: '', md5: 'a'.repeat(32) };
const release = {
  assets: [
    { name: 'latest.json', url: 'https://api.github.com/a/1', browser_download_url: 'https://github.com/dl/latest.json' },
    { name: latest.apk, url: 'https://api.github.com/a/2', browser_download_url: 'https://github.com/dl/apk' },
  ],
};
const res = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const fetchMock = jest.fn();

beforeEach(async () => {
  setOS('android');
  mockLauncher.mockReset();
  await AsyncStorage.clear();
  fetchMock.mockReset();
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  mockUpdates = { owner: 'o', repo: 'r', token: '', latestUrl: '' };
});

const call = (i: number) => ({ url: fetchMock.mock.calls[i][0] as string, headers: fetchMock.mock.calls[i][1].headers as Record<string, string> });

describe('checkForUpdate', () => {
  it('no token: anonymous requests, browser_download_url', async () => {
    fetchMock.mockResolvedValueOnce(res(200, release)).mockResolvedValueOnce(res(200, latest));
    const f = await checkForUpdate(true);
    expect(f?.build).toBe(5);
    expect(f?.apkUrl).toBe('https://github.com/dl/apk');
    expect(call(0).url).toBe('https://api.github.com/repos/o/r/releases/latest');
    expect(call(1).url).toBe('https://github.com/dl/latest.json');
    expect(call(0).headers.Authorization).toBeUndefined();
    expect(call(1).headers.Authorization).toBeUndefined();
  });
  it('token: authenticated, asset API urls', async () => {
    mockUpdates.token = 'tok';
    fetchMock.mockResolvedValueOnce(res(200, release)).mockResolvedValueOnce(res(200, latest));
    const f = await checkForUpdate(true);
    expect(f?.apkUrl).toBe('https://api.github.com/a/2');
    expect(call(0).headers.Authorization).toBe('Bearer tok');
    expect(call(1).url).toBe('https://api.github.com/a/1');
    expect(call(1).headers.Accept).toBe('application/octet-stream');
  });
  it('404 and 403 (rate limit) are quiet "none"; network errors throw', async () => {
    fetchMock.mockResolvedValueOnce(res(404));
    await expect(checkForUpdate(true)).resolves.toBeNull();
    fetchMock.mockResolvedValueOnce(res(403));
    await expect(checkForUpdate(true)).resolves.toBeNull();
    fetchMock.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(checkForUpdate(true)).rejects.toThrow('Network');
  });
  it('latestUrl override: fetches that JSON directly, absolute or relative apk, never sends the token', async () => {
    mockUpdates = { owner: '', repo: '', token: 'tok', latestUrl: 'http://10.0.2.2:8765/latest.json' };
    fetchMock.mockResolvedValueOnce(res(200, { ...latest, apk: 'http://10.0.2.2:8765/x.apk' }));
    expect((await checkForUpdate(true))?.apkUrl).toBe('http://10.0.2.2:8765/x.apk');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).url).toBe('http://10.0.2.2:8765/latest.json');
    expect(call(0).headers.Authorization).toBeUndefined();
    fetchMock.mockResolvedValueOnce(res(200, latest));
    expect((await checkForUpdate(true))?.apkUrl).toBe('http://10.0.2.2:8765/bola8-staff-1.2.0-5.apk');
  });
  it('not newer => null; owner/repo missing => not configured', async () => {
    fetchMock.mockResolvedValueOnce(res(200, release)).mockResolvedValueOnce(res(200, { ...latest, build: 4 }));
    await expect(checkForUpdate(true)).resolves.toBeNull();
    mockUpdates = { owner: '', repo: '', token: 'tok', latestUrl: '' };
    await expect(checkForUpdate(true)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('iOS: updater is inert', () => {
  const upd = { ...latest, apkUrl: 'http://h/x.apk' };
  it('never configured, never fetches, never launches the installer', async () => {
    setOS('ios');
    expect(updatesConfigured()).toBe(false);
    await expect(checkForUpdate(true)).resolves.toBeNull();
    await downloadUpdate(upd, () => {});
    await launchInstaller(upd);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLauncher).not.toHaveBeenCalled();
  });
});
