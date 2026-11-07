import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { __setServerUrlForTests, saveServerUrl } from '../../config/serverConfig';
import client from '../../api/client';
import { ACCESS_KEY, REFRESH_KEY, USER_KEY, getAuthEpoch, useAuthStore } from '../authStore';
import { queryClient } from '../queryClient';
import { useDraftStore } from '../../features/waiter/draft/draftStore';
import { AxiosError, type AxiosAdapter } from 'axios';

const user = { id: 'u1', username: 'ana', name: 'Ana', role: 'WAITER' };
const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;

function adapter(routes: Record<string, { status: number; data: unknown }>): AxiosAdapter {
  return async (cfg) => {
    const r = routes[`${cfg.method} ${cfg.url}`] ?? { status: 404, data: {} };
    const response = { status: r.status, statusText: '', headers: {}, config: cfg, data: r.data };
    if (r.status < 300) return response;
    throw new AxiosError('x', 'ERR_BAD_REQUEST', cfg, null, response);
  };
}

beforeEach(async () => {
  __setServerUrlForTests('http://10.0.2.2:8090');
  store.clear();
  await AsyncStorage.clear();
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null, hydrated: false });
});

it('login stores tokens in SecureStore only, user in AsyncStorage', async () => {
  client.defaults.adapter = adapter({
    'post /auth/login': { status: 200, data: { access_token: 'A', refresh_token: 'R', user } },
  });
  await useAuthStore.getState().login(' ana ', 'secret');

  expect(store.get(ACCESS_KEY)).toBe('A');
  expect(store.get(REFRESH_KEY)).toBe('R');
  const persisted = JSON.stringify(await AsyncStorage.getAllKeys()) + JSON.stringify(await AsyncStorage.multiGet(await AsyncStorage.getAllKeys()));
  expect(persisted).toContain(USER_KEY);
  expect(persisted).not.toContain('"A"');
  expect(persisted).not.toContain('"R"');
  expect(persisted).not.toContain('secret');
  expect(useAuthStore.getState().user).toEqual(user);
});

it('hydrate restores a session; partial state means logged out', async () => {
  store.set(ACCESS_KEY, 'A');
  store.set(REFRESH_KEY, 'R');
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
  await useAuthStore.getState().hydrate();
  expect(useAuthStore.getState()).toMatchObject({ user, accessToken: 'A', refreshToken: 'R', hydrated: true });

  store.delete(REFRESH_KEY);
  await useAuthStore.getState().hydrate();
  expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, hydrated: true });
});

it('logout clears SecureStore, AsyncStorage user and the query cache', async () => {
  client.defaults.adapter = adapter({
    'post /auth/login': { status: 200, data: { access_token: 'A', refresh_token: 'R', user } },
    'post /auth/logout': { status: 200, data: {} },
  });
  await useAuthStore.getState().login('ana', 'x');
  queryClient.setQueryData(['resources'], [1]);

  await useAuthStore.getState().logout();

  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(ACCESS_KEY);
  expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(REFRESH_KEY);
  expect(store.size).toBe(0);
  expect(await AsyncStorage.getItem(USER_KEY)).toBeNull();
  expect(queryClient.getQueryData(['resources'])).toBeUndefined();
  expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, refreshToken: null });
});

it('logout still works when the server is unreachable', async () => {
  client.defaults.adapter = async (cfg) => {
    throw new AxiosError('net', 'ERR_NETWORK', cfg);
  };
  useAuthStore.setState({ user, accessToken: 'A', refreshToken: 'R' });
  store.set(ACCESS_KEY, 'A');
  await useAuthStore.getState().logout();
  expect(store.size).toBe(0);
  expect(useAuthStore.getState().user).toBeNull();
});


it('SEC-04: logout clears ALL persisted drafts (memory and AsyncStorage) and the owner', async () => {
  client.defaults.adapter = adapter({ 'post /auth/logout': { status: 200, data: {} } });
  useAuthStore.setState({ user: user as never, accessToken: 'A', refreshToken: 'R' });
  useDraftStore.getState().claimDrafts('u1');
  useDraftStore.getState().addLine('t1', { menuItemId: 'm', name: 'Nachos', unitPriceCents: 1, quantity: 1, modifiers: [], notes: '' });
  useDraftStore.getState().addLine('t2', { menuItemId: 'm', name: 'Alitas', unitPriceCents: 1, quantity: 1, modifiers: [], notes: '' });
  expect(await AsyncStorage.getItem('bola8.waiter.drafts')).toContain('Nachos');

  await useAuthStore.getState().logout();

  expect(useDraftStore.getState()).toMatchObject({ byTicket: {}, ownerId: null });
  const raw = await AsyncStorage.getItem('bola8.waiter.drafts');
  expect(raw === null || !/Nachos|Alitas/.test(raw)).toBe(true);
});

it("SEC-04: logging in as a different user drops the previous user's drafts", async () => {
  client.defaults.adapter = adapter({ 'post /auth/login': { status: 200, data: { access_token: 'A', refresh_token: 'R', user: { ...user, id: 'u2' } } } });
  useDraftStore.getState().claimDrafts('u1');
  useDraftStore.getState().addLine('t1', { menuItemId: 'm', name: 'Nachos', unitPriceCents: 1, quantity: 1, modifiers: [], notes: '' });
  await useAuthStore.getState().login('other', 'pw');
  expect(useDraftStore.getState().byTicket).toEqual({});
});

it('F4: every mutation inherits networkMode "always" from the query client (no per-call overrides)', () => {
  expect(queryClient.getDefaultOptions().mutations).toMatchObject({ networkMode: 'always', retry: 0 });
});

describe('stale auth responses after a server switch / logout', () => {
  const A = 'http://10.0.2.2:8090';
  const B = 'http://10.0.2.3:8090';
  const loginOk = { access_token: 'A-ACCESS', refresh_token: 'A-REFRESH', user };

  /** Adapter whose login/refresh responses are released by hand; records every request. */
  function gated() {
    const seen: { url: string; base: string; auth?: string }[] = [];
    const gates: Record<string, () => void> = {};
    const adapterFn: AxiosAdapter = async (cfg) => {
      seen.push({ url: cfg.url ?? '', base: cfg.baseURL ?? '', auth: cfg.headers?.Authorization as string | undefined });
      const mk = (status: number, data: unknown) => ({ status, statusText: '', headers: {}, config: cfg, data });
      if (cfg.url === '/auth/login') {
        await new Promise<void>((r) => (gates.login = r));
        return mk(200, loginOk);
      }
      if (cfg.url === '/auth/refresh') {
        await new Promise<void>((r) => (gates.refresh = r));
        return mk(200, { access_token: 'A-NEW' });
      }
      if (cfg.url === '/resources' && cfg.baseURL?.startsWith(A) && cfg.headers?.Authorization === 'Bearer old') {
        throw new AxiosError('x', 'ERR_BAD_REQUEST', cfg, null, mk(401, { msg: 'Token has expired' }));
      }
      return mk(200, []);
    };
    return { seen, gates, adapterFn };
  }

  const nothingPersisted = () => {
    expect(store.size).toBe(0);
    expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, refreshToken: null });
  };

  it('login on A pending -> switch to B -> A resolves: nothing stored, next B request has no A token', async () => {
    const g = gated();
    client.defaults.adapter = g.adapterFn;
    const pending = useAuthStore.getState().login('ana', 'pw');
    await Promise.resolve();
    await saveServerUrl(B);
    g.gates.login();
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_ENDED' });

    nothingPersisted();
    await client.get('/resources');
    const last = g.seen[g.seen.length - 1];
    expect(last.base).toBe(`${B}/api/v1`);
    expect(last.auth).toBeUndefined();
  });

  it('logout during a pending login discards the response', async () => {
    const g = gated();
    client.defaults.adapter = g.adapterFn;
    const pending = useAuthStore.getState().login('ana', 'pw');
    await Promise.resolve();
    await useAuthStore.getState().logout();
    g.gates.login();
    await expect(pending).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    nothingPersisted();
  });

  it('exports an epoch that moves on server change and logout', async () => {
    const e0 = getAuthEpoch();
    await saveServerUrl(B);
    expect(getAuthEpoch()).toBeGreaterThan(e0);
    const e1 = getAuthEpoch();
    await useAuthStore.getState().logout();
    expect(getAuthEpoch()).toBeGreaterThan(e1);
  });

  it('refresh started on A, server switched to B: new access token is not stored', async () => {
    const g = gated();
    client.defaults.adapter = g.adapterFn;
    await saveServerUrl(A);
    useAuthStore.setState({ user: user as never, accessToken: 'old', refreshToken: 'A-REFRESH' });
    const req = client.get('/resources');
    for (let i = 0; i < 20 && !g.gates.refresh; i++) await new Promise((r) => setTimeout(r, 0));
    await saveServerUrl(B); // switch without logout: the refresh guard alone must hold
    g.gates.refresh();
    await expect(req).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    expect(useAuthStore.getState().accessToken).toBe('old');
    expect(store.get(ACCESS_KEY)).toBeUndefined();
  });
});
