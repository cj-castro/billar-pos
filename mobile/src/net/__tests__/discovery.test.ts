import { discoverServer, probe } from '../discovery';

const mockSave = jest.fn();
let mockStored: string | null = null;
let mockIp = '192.168.1.50';
jest.mock('../../config/serverConfig', () => ({
  DEFAULT_PORT: 8080,
  loadServerUrl: () => Promise.resolve(mockStored),
  saveServerUrl: (u: string) => mockSave(u),
}));
jest.mock('expo-network', () => ({ getIpAddressAsync: () => Promise.resolve(mockIp) }));
jest.mock('expo-constants', () => ({ expoConfig: { extra: { serverCandidates: ['http://192.168.1.24:8080', 'http://100.78.80.83:8080'] } } }));

const asked: string[] = [];
const answer = (live: string[], body: unknown = { status: 'ok' }) => {
  asked.length = 0;
  global.fetch = jest.fn(async (u: string) => {
    asked.push(u.replace('/api/v1/health', ''));
    if (!live.includes(asked[asked.length - 1])) throw new Error('down');
    return { status: 200, json: async () => body };
  }) as unknown as typeof fetch;
};

beforeEach(() => {
  mockSave.mockClear();
  mockStored = null;
  mockIp = '192.168.1.50';
});

test('probe accepts legacy {"status":"ok"} and rejects non-health bodies', async () => {
  answer(['http://x:8080']);
  expect(await probe('http://x:8080')).toBe(true);
  answer(['http://x:8080'], { hello: 1 });
  expect(await probe('http://x:8080')).toBe(false);
});

test('last-good beats candidates; hit is persisted; no scan', async () => {
  mockStored = 'http://192.168.1.99:8080';
  answer([mockStored, 'http://192.168.1.24:8080']);
  expect(await discoverServer()).toBe(mockStored);
  expect(mockSave).toHaveBeenCalledWith(mockStored);
  expect(asked).toHaveLength(3);
});

test('falls through to the second candidate in order', async () => {
  answer(['http://100.78.80.83:8080']);
  expect(await discoverServer()).toBe('http://100.78.80.83:8080');
});

test('scan finds the server, skips own IP, stops early', async () => {
  answer(['http://192.168.1.7:8080']);
  expect(await discoverServer()).toBe('http://192.168.1.7:8080');
  expect(asked).not.toContain('http://192.168.1.50:8080');
  expect(asked.length).toBeLessThan(2 + 253);
});

test('returns null when nothing answers or IP is not private', async () => {
  answer([]);
  expect(await discoverServer()).toBeNull();
  expect(mockSave).not.toHaveBeenCalled();
  mockIp = '8.8.8.8';
  answer([]);
  expect(await discoverServer()).toBeNull();
  expect(asked).toHaveLength(2);
});
