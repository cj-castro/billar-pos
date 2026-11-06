import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { setAuthBridge } from '../api/client';
import * as authApi from '../api/endpoints/auth';
import type { User } from '../domain/types';
import { useDraftStore } from '../features/waiter/draft/draftStore';
import { disconnectSocket } from '../realtime/socket';
import { queryClient } from './queryClient';

export const ACCESS_KEY = 'bola8.accessToken';
export const REFRESH_KEY = 'bola8.refreshToken';
export const USER_KEY = 'bola8.user'; // non-secret profile: AsyncStorage is fine

interface AuthState {
  user: User | null;
  accessToken: string | null;
  refreshToken: string | null;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  login: (username: string, password: string) => Promise<User>;
  setAccessToken: (token: string) => Promise<void>;
  setUser: (user: User) => void;
  logout: () => Promise<void>;
}

async function clearPersisted() {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {}),
    AsyncStorage.removeItem(USER_KEY).catch(() => {}),
  ]);
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  accessToken: null,
  refreshToken: null,
  hydrated: false,

  hydrate: async () => {
    try {
      const [accessToken, refreshToken, rawUser] = await Promise.all([
        SecureStore.getItemAsync(ACCESS_KEY),
        SecureStore.getItemAsync(REFRESH_KEY),
        AsyncStorage.getItem(USER_KEY),
      ]);
      const user = rawUser ? (JSON.parse(rawUser) as User) : null;
      // All three or nothing: a partial state is treated as logged out.
      if (accessToken && refreshToken && user) set({ user, accessToken, refreshToken, hydrated: true });
      else set({ user: null, accessToken: null, refreshToken: null, hydrated: true });
    } catch {
      set({ user: null, accessToken: null, refreshToken: null, hydrated: true });
    }
  },

  login: async (username, password) => {
    const res = await authApi.login(username.trim(), password);
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, res.access_token),
      SecureStore.setItemAsync(REFRESH_KEY, res.refresh_token),
      AsyncStorage.setItem(USER_KEY, JSON.stringify(res.user)),
    ]);
    queryClient.clear(); // never show the previous user's cache
    useDraftStore.getState().claimDrafts(res.user.id); // SEC-04: another user never inherits unsent lines
    set({ user: res.user, accessToken: res.access_token, refreshToken: res.refresh_token });
    return res.user;
  },

  setAccessToken: async (token) => {
    await SecureStore.setItemAsync(ACCESS_KEY, token);
    set({ accessToken: token });
  },

  setUser: (user) => {
    set({ user });
    AsyncStorage.setItem(USER_KEY, JSON.stringify(user)).catch(() => {});
  },

  logout: async () => {
    const hadToken = !!get().accessToken;
    // Best effort server-side revoke of the access jti; never block local logout on it.
    if (hadToken) await authApi.logout().catch(() => {});
    set({ user: null, accessToken: null, refreshToken: null });
    disconnectSocket();
    await clearPersisted();
    queryClient.clear();
    // SEC-04: logout drops every persisted per-user draft (the confirm dialog is the caller's job).
    useDraftStore.getState().clearAll();
    await useDraftStore.persist.clearStorage();
  },
}));

setAuthBridge({
  getAccessToken: () => useAuthStore.getState().accessToken,
  getRefreshToken: () => useAuthStore.getState().refreshToken,
  setAccessToken: (t) => useAuthStore.getState().setAccessToken(t),
  onSessionExpired: async () => {
    // Already rejected by the server: skip the logout round-trip.
    useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
    await clearPersisted();
    queryClient.clear();
  },
});
