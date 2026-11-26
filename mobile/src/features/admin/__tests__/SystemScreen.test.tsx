import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from '../../../api/client';
import { health } from '../../../api/endpoints/health';
import { getSetting, putSetting } from '../../../api/endpoints/settings';
import { useConnectionStore } from '../../../realtime/socket';
import { useAuthStore } from '../../../state/authStore';
import { mockServerConfig, renderWithProviders, TEST_SERVER } from '../../../test/utils';
import { SystemScreen } from '../SystemScreen';

jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return { Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text> };
});
jest.mock('../../../api/endpoints/health');
jest.mock('../../../api/endpoints/settings');
jest.mock('../../../utils/haptics', () => ({
  haptic: { selection: jest.fn(), light: jest.fn(), medium: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const clients: { clear: () => void }[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  mockServerConfig();
  useConnectionStore.setState({ state: 'connected', lastConnectedAt: Date.now() });
  useAuthStore.setState({ user: { id: 'a', username: 'admin', name: 'Admin', role: 'ADMIN' } });
  (health as jest.Mock).mockResolvedValue({ status: 'ok' });
  (getSetting as jest.Mock).mockImplementation(async (key: string) => ({ key, value: key === 'kds_sound_enabled' ? 'true' : 'false' }));
  (putSetting as jest.Mock).mockImplementation(async (key: string, value: string) => ({ key, value }));
});
afterEach(() => {
  clients.splice(0).forEach((c) => c.clear());
  useAuthStore.setState({ user: null });
});

async function show() {
  const r = await renderWithProviders(<SystemScreen />);
  clients.push(r.queryClient);
  return r;
}

describe('SystemScreen (admin diagnostics)', () => {
  it('shows server, health + latency, socket state, user and version', async () => {
    await show();
    expect(screen.getByText(TEST_SERVER)).toBeTruthy();
    expect(await screen.findByText(/En línea · \d+ ms/)).toBeTruthy();
    expect(screen.getByText(/^Conectado · /)).toBeTruthy();
    expect(screen.getByText('Admin · Administrador')).toBeTruthy();
    expect(screen.getByTestId('diag-version')).toBeTruthy();
  });

  it('"Probar conexión" re-probes and reports a failure with "Sin respuesta"', async () => {
    await show();
    await screen.findByText(/En línea · \d+ ms/);
    (health as jest.Mock).mockRejectedValue(new ApiError({ code: 'NETWORK_ERROR', message: '', isNetwork: true }));
    await fireEvent.press(screen.getByTestId('diag-test'));
    expect(await screen.findByText('Sin respuesta')).toBeTruthy();
    expect(health).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('diag-last-ok')).toBeTruthy(); // last OK time kept
  });

  it('toggle asks for confirmation, then PUTs the new value', async () => {
    await show();
    const sw = await screen.findByTestId('switch-kds_sound_enabled');
    await waitFor(() => expect(sw.props.disabled).toBeFalsy());
    await fireEvent(sw, 'valueChange', false);
    expect(await screen.findByText('¿Cambiar este ajuste?')).toBeTruthy();
    expect(putSetting).not.toHaveBeenCalled(); // nothing before the confirm
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(putSetting).toHaveBeenCalledWith('kds_sound_enabled', 'false'));
  });

  it('cancelling the confirmation changes nothing', async () => {
    await show();
    const sw = await screen.findByTestId('switch-print_bar_tickets');
    await waitFor(() => expect(sw.props.disabled).toBeFalsy());
    await fireEvent(sw, 'valueChange', true);
    await fireEvent.press(await screen.findByTestId('confirm-dialog-cancel'));
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('a rejected PUT (403) surfaces an error and keeps the old value', async () => {
    (putSetting as jest.Mock).mockRejectedValue(new ApiError({ status: 403, code: 'Forbidden', message: '' }));
    await show();
    const sw = await screen.findByTestId('switch-print_bar_tickets');
    await waitFor(() => expect(sw.props.disabled).toBeFalsy());
    await fireEvent(sw, 'valueChange', true);
    await fireEvent.press(await screen.findByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(putSetting).toHaveBeenCalled());
    expect(screen.getByTestId('switch-print_bar_tickets').props.value).toBe(false);
  });

  it('numeric setting editor validates and PUTs the string value', async () => {
    (getSetting as jest.Mock).mockImplementation(async (key: string) => ({ key, value: key === 'kds_warn_min' ? '10' : 'false' }));
    await show();
    const input = await screen.findByTestId('input-kds_warn_min');
    await waitFor(() => expect(input.props.value).toBe('10'));
    await fireEvent.changeText(input, 'abc');
    await fireEvent.press(screen.getByTestId('save-kds_warn_min'));
    expect(putSetting).not.toHaveBeenCalled();
    expect(await screen.findByText('Número inválido')).toBeTruthy();
    await fireEvent.changeText(input, '15');
    await fireEvent.press(screen.getByTestId('save-kds_warn_min'));
    await waitFor(() => expect(putSetting).toHaveBeenCalledWith('kds_warn_min', '15'));
    expect(screen.getByTestId('diag-min-version')).toBeTruthy();
  });

  it.each(['MANAGER', 'WAITER', 'KITCHEN_STAFF', 'BAR_STAFF'])('%s deep-linking to /system is sent to /denied and sees no diagnostics', async (role) => {
    useAuthStore.setState({ user: { id: 'x', username: 'x', name: 'X', role } });
    await show();
    expect(screen.getByTestId('redirect').props.children).toBe('/denied');
    expect(screen.queryByTestId('diag-server')).toBeNull();
    expect(health).not.toHaveBeenCalled();
  });
});
