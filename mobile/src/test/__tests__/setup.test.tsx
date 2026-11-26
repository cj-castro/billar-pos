import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import axios from 'axios';
import * as SecureStore from 'expo-secure-store';
import SetupScreen from '../../../app/setup';
import { __setServerUrlForTests, getServerUrl, SERVER_URL_KEY } from '../../config/serverConfig';
import { useDraftStore } from '../../features/waiter/draft/draftStore';
import { ACCESS_KEY, REFRESH_KEY, USER_KEY, useAuthStore } from '../../state/authStore';
import { queryClient } from '../../state/queryClient';
import * as socket from '../../realtime/socket';
import { renderWithProviders } from '../utils';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useLocalSearchParams: () => ({}), useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

const store = (SecureStore as unknown as { __store: Map<string, string> }).__store;
const user = { id: 'u1', username: 'ana', name: 'Ana', role: 'WAITER' as const, is_active: true };

beforeEach(async () => {
  jest.clearAllMocks();
  store.clear();
  await AsyncStorage.clear();
  __setServerUrlForTests('http://192.168.1.50:8080');
  useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
  useDraftStore.setState({ byTicket: {}, ownerId: null });
  jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { status: 'ok' } });
});
afterEach(() => jest.restoreAllMocks());

const connect = async (url: string) => {
  await fireEvent.changeText(screen.getByTestId('server-input'), url);
  await fireEvent.press(screen.getByTestId('server-connect'));
  await screen.findByTestId('server-ok');
};

function signIn() {
  store.set(ACCESS_KEY, 'A');
  store.set(REFRESH_KEY, 'R');
  void AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
  useAuthStore.setState({ user, accessToken: 'A', refreshToken: 'R' });
  useDraftStore.getState().claimDrafts('u1');
  useDraftStore.getState().addLine('t1', { menuItemId: 'm', name: 'Nachos', unitPriceCents: 1, quantity: 1, modifiers: [], notes: '' });
  queryClient.setQueryData(['x'], 1);
}

describe('SEC-02: changing the server URL while signed in', () => {
  it('asks first; cancelling keeps the session and the old URL', async () => {
    signIn();
    await renderWithProviders(<SetupScreen />);
    await connect('192.168.1.99:8080');
    await fireEvent.press(screen.getByTestId('server-continue'));
    expect(screen.getByTestId('switch-server-dialog')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('switch-server-dialog-cancel'));
    expect(useAuthStore.getState().accessToken).toBe('A');
    expect(getServerUrl()).toBe('http://192.168.1.50:8080');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('confirming ends the session completely (tokens, user, cache, socket, drafts) BEFORE saving the new URL', async () => {
    signIn();
    const disconnect = jest.spyOn(socket, 'disconnectSocket');
    await renderWithProviders(<SetupScreen />);
    await connect('192.168.1.99:8080');
    await fireEvent.press(screen.getByTestId('server-continue'));
    await fireEvent.press(screen.getByTestId('switch-server-dialog-confirm'));

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(useAuthStore.getState()).toMatchObject({ user: null, accessToken: null, refreshToken: null });
    expect(store.has(ACCESS_KEY)).toBe(false);
    expect(store.has(REFRESH_KEY)).toBe(false);
    expect(await AsyncStorage.getItem(USER_KEY)).toBeNull();
    expect(queryClient.getQueryData(['x'])).toBeUndefined();
    expect(disconnect).toHaveBeenCalled();
    expect(useDraftStore.getState().byTicket).toEqual({});
    expect(getServerUrl()).toBe('http://192.168.1.99:8080');
    expect(await AsyncStorage.getItem(SERVER_URL_KEY)).toBe('http://192.168.1.99:8080');
  });

  it('re-saving the same address does not log anyone out', async () => {
    signIn();
    await renderWithProviders(<SetupScreen />);
    await connect('192.168.1.50'); // normalises to the same http://192.168.1.50:8080
    await fireEvent.press(screen.getByTestId('server-continue'));
    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
    expect(screen.queryByTestId('switch-server-dialog')).toBeNull();
    expect(useAuthStore.getState().accessToken).toBe('A');
  });
});

describe('SEC-03 in the setup screen', () => {
  it('a public http:// host shows the Spanish validation error and never calls the network', async () => {
    await renderWithProviders(<SetupScreen />);
    await fireEvent.changeText(screen.getByTestId('server-input'), 'http://evil.example.com');
    await fireEvent.press(screen.getByTestId('server-connect'));
    expect(await screen.findByText(/Solo se permite http:\/\/ en la red local/)).toBeTruthy();
    expect(axios.get).not.toHaveBeenCalled();
    expect(screen.queryByTestId('server-ok')).toBeNull();
  });
});
