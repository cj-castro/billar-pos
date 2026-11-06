import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { __setServerUrlForTests } from '../../config/serverConfig';
import client, { ApiError, setAuthBridge, toApiError } from '../client';

type Reply = { status: number; data: unknown } | { error: string };

/** Scriptable adapter: handler decides the reply for each request. */
function useAdapter(handler: (cfg: InternalAxiosRequestConfig) => Reply | Promise<Reply>) {
  const calls: InternalAxiosRequestConfig[] = [];
  const adapter: AxiosAdapter = async (cfg) => {
    calls.push(cfg);
    const r = await handler(cfg);
    if ('error' in r) throw new AxiosError('boom', r.error, cfg);
    const response = { status: r.status, statusText: '', headers: {}, config: cfg, data: r.data };
    if (r.status >= 200 && r.status < 300) return response;
    throw new AxiosError('failed', 'ERR_BAD_REQUEST', cfg, null, response);
  };
  client.defaults.adapter = adapter;
  return calls;
}

let session: { access: string | null; refresh: string | null; expired: number };

beforeEach(() => {
  __setServerUrlForTests('http://192.168.1.22:8080');
  session = { access: 'old-access', refresh: 'the-refresh', expired: 0 };
  setAuthBridge({
    getAccessToken: () => session.access,
    getRefreshToken: () => session.refresh,
    setAccessToken: (t) => {
      session.access = t;
    },
    onSessionExpired: () => {
      session.expired += 1;
      session.access = null;
      session.refresh = null;
    },
  });
});

const get = (path: string) => client.get(path).catch((e: unknown) => e as ApiError);

describe('request config', () => {
  it('uses configured base + /api/v1, injects Bearer, 8s timeout', async () => {
    const calls = useAdapter(() => ({ status: 200, data: { ok: 1 } }));
    await client.get('/resources');
    expect(calls[0].baseURL).toBe('http://192.168.1.22:8080/api/v1');
    expect(calls[0].headers.Authorization).toBe('Bearer old-access');
    expect(calls[0].timeout).toBe(8000);
  });

  it('fails with NO_SERVER when nothing is configured', async () => {
    __setServerUrlForTests(null);
    useAdapter(() => ({ status: 200, data: {} }));
    expect(await get('/x')).toMatchObject({ code: 'NO_SERVER' });
  });
});

describe('error normalization', () => {
  it('JSON {error, message}', async () => {
    useAdapter(() => ({ status: 409, data: { error: 'RESOURCE_OCCUPIED', message: 'Mesa ocupada' } }));
    const e = await get('/x');
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 409, code: 'RESOURCE_OCCUPIED', message: 'Mesa ocupada', isNetwork: false, isTimeout: false });
  });

  it('JSON with human sentence in `error`, and flask-jwt {msg}', async () => {
    useAdapter(() => ({ status: 400, data: { error: 'Algo salió mal' } }));
    expect(await get('/x')).toMatchObject({ status: 400, code: 'HTTP_400', message: 'Algo salió mal' });
    useAdapter(() => ({ status: 422, data: { msg: 'Signature verification failed' } }));
    expect(await get('/x')).toMatchObject({ status: 422, message: 'Signature verification failed' });
  });

  it('HTML error body does not crash', async () => {
    useAdapter(() => ({ status: 500, data: '<!doctype html><title>500</title>' }));
    expect(await get('/x')).toMatchObject({ status: 500, code: 'HTTP_500', message: 'Request failed (500)' });
  });

  it('timeout', async () => {
    useAdapter(() => ({ error: 'ECONNABORTED' }));
    expect(await get('/x')).toMatchObject({ status: null, code: 'TIMEOUT', isTimeout: true, isNetwork: false });
  });

  it('network error', async () => {
    useAdapter(() => ({ error: 'ERR_NETWORK' }));
    expect(await get('/x')).toMatchObject({ status: null, code: 'NETWORK_ERROR', isNetwork: true, isTimeout: false });
  });

  it('toApiError is idempotent and handles non-axios errors', () => {
    const e = new ApiError({ code: 'A', message: 'm' });
    expect(toApiError(e)).toBe(e);
    expect(toApiError(new Error('x'))).toMatchObject({ code: 'UNKNOWN', message: 'x' });
  });
});

describe('refresh on 401', () => {
  it('two concurrent 401s trigger exactly one refresh, both retried with the new token', async () => {
    let refreshCalls = 0;
    const calls = useAdapter(async (cfg) => {
      if (cfg.url === '/auth/refresh') {
        refreshCalls += 1;
        expect(cfg.headers.Authorization).toBe('Bearer the-refresh');
        await new Promise((r) => setTimeout(r, 10));
        return { status: 200, data: { access_token: 'new-access' } };
      }
      return cfg.headers.Authorization === 'Bearer new-access' ? { status: 200, data: { ok: true } } : { status: 401, data: { msg: 'expired' } };
    });

    const [a, b] = await Promise.all([client.get('/a'), client.get('/b')]);
    expect(a.data).toEqual({ ok: true });
    expect(b.data).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(session.access).toBe('new-access');
    expect(calls.filter((c) => c.url === '/a')).toHaveLength(2);
  });

  it('refresh rejected (401) -> session expired once, caller gets ApiError', async () => {
    useAdapter((cfg) => (cfg.url === '/auth/refresh' ? { status: 401, data: { error: 'USER_INACTIVE' } } : { status: 401, data: {} }));
    const e = await get('/a');
    expect(e).toMatchObject({ status: 401, code: 'USER_INACTIVE' });
    expect(session.expired).toBe(1);
  });

  it('refresh network failure does NOT log out', async () => {
    useAdapter((cfg) => (cfg.url === '/auth/refresh' ? { error: 'ERR_NETWORK' } : { status: 401, data: {} }));
    const e = await get('/a');
    expect(e).toMatchObject({ isNetwork: true });
    expect(session.expired).toBe(0);
  });

  it('no refresh token -> session expired', async () => {
    session.refresh = null;
    useAdapter(() => ({ status: 401, data: {} }));
    await get('/a');
    expect(session.expired).toBe(1);
  });

  it('_noAuth requests (login) never refresh', async () => {
    const calls = useAdapter(() => ({ status: 401, data: { error: 'INVALID_CREDENTIALS' } }));
    const e = await client.post('/auth/login', {}, { _noAuth: true } as never).catch((x: unknown) => x as ApiError);
    expect(e).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' });
    expect(calls).toHaveLength(1);
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('M3: a wrong-PIN 401 (INVALID_PIN) is returned as is: no refresh, no replay of the PIN', async () => {
    const calls = useAdapter(() => ({ status: 401, data: { error: 'INVALID_PIN' } }));
    const e = await client.delete('/tickets/t/items/i', { data: { pin: '0000' } }).catch((x: unknown) => x as ApiError);
    expect(e).toMatchObject({ status: 401, code: 'INVALID_PIN' });
    expect(calls).toHaveLength(1);
    expect(session.expired).toBe(0);
  });

  it('SEC-10: a refresh that returns after logout is discarded (no token written back)', async () => {
    useAdapter(async (cfg) => {
      if (cfg.url === '/auth/refresh') {
        session.refresh = null; // user logged out while the refresh was in flight
        return { status: 200, data: { access_token: 'late' } };
      }
      return { status: 401, data: { msg: 'expired' } };
    });
    const e = await get('/a');
    expect(e).toMatchObject({ code: 'SESSION_ENDED' });
    expect(session.access).toBe('old-access');
  });
});
