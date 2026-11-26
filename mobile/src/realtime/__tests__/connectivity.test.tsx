import NetInfo from '@react-native-community/netinfo';
import { act, renderHook, screen } from '@testing-library/react-native';
import axios from 'axios';
import { useConnectionLevel } from '../../components/connection';
import { __setServerUrlForTests, saveServerUrl } from '../../config/serverConfig';
import { useDraftStore } from '../../features/waiter/draft/draftStore';
import { DraftScreen } from '../../features/waiter/draft/DraftScreen';
import { makeRouter, mockApi, online, renderScreen, ticket } from '../../features/waiter/testing/testkit';
import { computeOnline, configureReachability, probePos, startConnectivity, usePosReachability } from '../connectivity';

const mockRouter = makeRouter();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const useNetInfoMock = NetInfo.useNetInfo as jest.Mock;
const noInternet = { type: 'wifi', isConnected: true, isInternetReachable: false, details: {} };

beforeEach(() => {
  jest.clearAllMocks();
  __setServerUrlForTests('http://192.168.1.50:8080');
  usePosReachability.setState({ reachable: null });
  online(false); // socket not connected
  useNetInfoMock.mockReturnValue(noInternet); // Wi-Fi up, "no internet" (the bar LAN)
  useDraftStore.setState({ byTicket: {} });
});
afterEach(() => jest.restoreAllMocks());

describe('computeOnline (C1: never internet reachability)', () => {
  it.each([
    [{ isConnected: true }, null, false, true], // unknown yet: trust the link
    [{ isConnected: false }, true, false, true], // health answered: online whatever the link says
    [{ isConnected: false }, null, true, true], // socket connected
    [{ isConnected: false }, null, false, false],
    [{ isConnected: true }, false, false, false], // link up but POS down
  ] as const)('%j pos=%s socket=%s -> %s', (net, pos, sock, expected) => {
    expect(computeOnline(net, pos, sock)).toBe(expected);
  });
});

describe('NetInfo.configure', () => {
  it('targets the POS health endpoint and accepts only HTTP 200', async () => {
    configureReachability('http://192.168.1.50:8080');
    const cfg = (NetInfo.configure as jest.Mock).mock.calls[0][0];
    expect(cfg).toMatchObject({ reachabilityUrl: 'http://192.168.1.50:8080/api/v1/health', useNativeReachability: false });
    await expect(cfg.reachabilityTest({ status: 200 })).resolves.toBe(true);
    await expect(cfg.reachabilityTest({ status: 204 })).resolves.toBe(false);
    expect(cfg.reachabilityShortTimeout).toBeLessThanOrEqual(10_000);
  });

  it('is re-configured when the server URL changes', async () => {
    const stop = startConnectivity();
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { status: 'ok' } });
    (NetInfo.configure as jest.Mock).mockClear();
    await saveServerUrl('10.0.0.9');
    expect(NetInfo.configure).toHaveBeenCalledWith(expect.objectContaining({ reachabilityUrl: 'http://10.0.0.9:8080/api/v1/health' }));
    stop();
  });
});

describe('NetInfo isInternetReachable=false but POS health OK', () => {
  it('the app is online (not offline) and mutations are enabled', async () => {
    jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { status: 'ok' } });
    const level = await renderHook(() => useConnectionLevel());
    expect(level.result.current).toBe('offline'); // before the probe: no socket, nothing known
    await act(async () => void (await probePos()));
    expect(level.result.current).not.toBe('offline');

    // ... and a mutating button (Enviar) is enabled
    mockApi({ 'GET /tickets/t1': { data: ticket({ version: 1 }) } });
    useDraftStore.getState().addLine('t1', { menuItemId: 'm', name: 'Nachos', unitPriceCents: 9500, quantity: 1, modifiers: [], notes: '' });
    await renderScreen(<DraftScreen ticketId="t1" />);
    expect(screen.getByTestId('draft-send').props.accessibilityState.disabled).toBe(false);
  });

  it('health failing -> offline and Enviar disabled', async () => {
    jest.spyOn(axios, 'get').mockRejectedValue({ code: 'ERR_NETWORK' });
    await act(async () => void (await probePos()));
    expect((await renderHook(() => useConnectionLevel())).result.current).toBe('offline');
    mockApi({ 'GET /tickets/t1': { data: ticket({ version: 1 }) } });
    useDraftStore.getState().addLine('t1', { menuItemId: 'm', name: 'Nachos', unitPriceCents: 9500, quantity: 1, modifiers: [], notes: '' });
    await renderScreen(<DraftScreen ticketId="t1" />);
    expect(screen.getByTestId('draft-send').props.accessibilityState.disabled).toBe(true);
  });
});
