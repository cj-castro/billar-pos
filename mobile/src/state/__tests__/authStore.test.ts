import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { __setServerUrlForTests } from '../../config/serverConfig';
import client from '../../api/client';
import { ACCESS_KEY, REFRESH_KEY, USER_KEY, useAuthStore } from '../authStore';
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

  expect(useDraftStore.getState()).toMatchObject({ byTicket: {}, ownerId: null, b1Confirmed: {} });
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
