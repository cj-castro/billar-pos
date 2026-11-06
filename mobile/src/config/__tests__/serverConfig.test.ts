import axios from 'axios';
import { isPrivateHost, normalizeServerUrl, serverUrlProblem, validateServer } from '../serverConfig';

describe('normalizeServerUrl', () => {
  it.each([
    ['192.168.1.22:8080', 'http://192.168.1.22:8080'],
    ['  192.168.1.22:8080/  ', 'http://192.168.1.22:8080'],
    ['http://10.0.2.2:8090', 'http://10.0.2.2:8090'],
    ['HTTP://Pos.Local:8080//', 'http://pos.local:8080'],
    ['https://pos.example.com', 'https://pos.example.com'],
    ['192.168.1.22:8080/api/v1', 'http://192.168.1.22:8080'],
    ['192.168.1.22', 'http://192.168.1.22:8080'],
    ['pos.local', 'http://pos.local:8080'],
    ['http://10.0.0.5', 'http://10.0.0.5:8080'],
    ['192.168.1.22:80', 'http://192.168.1.22:80'],
    ['https://pos.example.com:8443', 'https://pos.example.com:8443'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });

  it.each(['', '   ', 'ftp://x.com', 'http://', 'a b c', '1.2.3.4:99999', 'http://host/some/path'])('rejects %j', (input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });
});

describe('validateServer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('ok when /api/v1/health returns {status:"ok"}', async () => {
    const get = jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { status: 'ok' } });
    await expect(validateServer('192.168.1.22:8080')).resolves.toEqual({ ok: true });
    expect(get).toHaveBeenCalledWith('http://192.168.1.22:8080/api/v1/health', expect.objectContaining({ timeout: 5000 }));
  });

  it('not_pos when body is not the health payload', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: '<html>router login</html>' });
    await expect(validateServer('192.168.1.1')).resolves.toEqual({ ok: false, reason: 'not_pos' });
  });

  it('timeout / unreachable / invalid', async () => {
    jest.spyOn(axios, 'get').mockRejectedValueOnce({ code: 'ECONNABORTED' });
    await expect(validateServer('10.0.0.1:8080')).resolves.toEqual({ ok: false, reason: 'timeout' });
    jest.spyOn(axios, 'get').mockRejectedValueOnce({ code: 'ERR_NETWORK' });
    await expect(validateServer('10.0.0.1:8080')).resolves.toEqual({ ok: false, reason: 'unreachable' });
    await expect(validateServer('')).resolves.toEqual({ ok: false, reason: 'invalid' });
  });
});

describe('SEC-03 URL guard', () => {
  it.each(['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.0.9:8080', '127.0.0.1', '169.254.1.1', 'localhost:8090', 'bar.local', '10.0.2.2:8090', 'http://MiPos.LOCAL'])('allows http to %s', (u) => {
    expect(serverUrlProblem(u)).toBeNull();
  });
  it.each(['http://example.com', '8.8.8.8:8080', '172.32.0.1', '172.15.0.1', '192.169.1.1', '11.0.0.1', 'http://evil.localhost.com', 'http://1.2.3.4'])('rejects http to %s as insecure', (u) => {
    expect(serverUrlProblem(u)).toBe('insecure');
  });
  it('allows https to any host and flags garbage as invalid', () => {
    expect(serverUrlProblem('https://pos.example.com')).toBeNull();
    expect(serverUrlProblem('https://8.8.8.8')).toBeNull();
    expect(serverUrlProblem('')).toBe('invalid');
  });
  it('isPrivateHost rejects out-of-range octets', () => {
    expect(isPrivateHost('10.300.1.1')).toBe(false);
  });
  it('validateServer refuses an insecure host without touching the network', async () => {
    const get = jest.spyOn(axios, 'get');
    await expect(validateServer('http://example.com')).resolves.toEqual({ ok: false, reason: 'insecure' });
    expect(get).not.toHaveBeenCalled();
    get.mockRestore();
  });
});
