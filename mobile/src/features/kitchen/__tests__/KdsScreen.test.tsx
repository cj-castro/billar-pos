import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { ApiError } from '../../../api/client';
import { getQueue, updateStatus } from '../../../api/endpoints/queue';
import { ToastProvider } from '../../../components/Toast';
import { useConnectionStore } from '../../../realtime/socket';
import { renderWithProviders } from '../../../test/utils';
import { KdsScreen } from '../KdsScreen';
import { qi } from '../testFixtures';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn(), canGoBack: () => false }) }));
jest.mock('../../../api/endpoints/queue');
jest.mock('../../../utils/haptics', () => ({
  haptic: { selection: jest.fn(), light: jest.fn(), medium: jest.fn(), success: jest.fn(), warning: jest.fn(), error: jest.fn() },
}));

const mockGet = getQueue as jest.Mock;
const mockPatch = updateStatus as jest.Mock;
const clients: { clear: () => void }[] = [];

async function show(ui: ReactElement) {
  const r = await renderWithProviders(<ToastProvider>{ui}</ToastProvider>);
  clients.push(r.queryClient);
  return r;
}

beforeEach(() => {
  jest.clearAllMocks();
  useConnectionStore.setState({ state: 'connected', lastConnectedAt: Date.now() });
  mockPatch.mockResolvedValue({});
});
afterEach(() => clients.splice(0).forEach((c) => c.clear()));

const queue = () => [
  qi({ id: 'late', ticket_id: 'tB', resource_code: 'M7', menu_item_name: 'Hamburguesa', sent_at: '2026-11-05T19:00:00+00:00', notes: 'sin cebolla', modifiers: [{ id: '1', modifier_id: 'm', name: 'Doble carne', price_cents: 0 }] }),
  qi({ id: 'early', ticket_id: 'tA', resource_code: 'M2', menu_item_name: 'Nachos', sent_at: '2026-11-05T18:00:00+00:00', status: 'IN_PROGRESS' }),
];

describe('KdsScreen', () => {
  it('lists tickets oldest first with items, modifiers and highlighted notes', async () => {
    mockGet.mockResolvedValue(queue());
    await show(<KdsScreen fixedStation="KITCHEN" />);
    expect(await screen.findByText('M2')).toBeTruthy();
    const wraps = screen.getAllByTestId(/^kds-wrap-/).map((n) => n.props.testID);
    expect(wraps).toEqual(['kds-wrap-tA', 'kds-wrap-tB']); // oldest ticket first
    expect(screen.getByText('Hamburguesa')).toBeTruthy();
    expect(screen.getByText('Doble carne')).toBeTruthy();
    expect(screen.getByText('sin cebolla')).toBeTruthy();
    expect(mockGet).toHaveBeenCalledWith('KITCHEN');
  });

  it('tapping an item advances exactly one step (SENT -> IN_PROGRESS) optimistically', async () => {
    mockGet.mockResolvedValue(queue());
    await show(<KdsScreen fixedStation="KITCHEN" />);
    await screen.findByText('Hamburguesa');
    await fireEvent.press(screen.getByTestId('kds-item-late'));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('late', 'IN_PROGRESS'));
    expect(mockPatch).toHaveBeenCalledTimes(1);
    // row now offers the next action ("Listo")
    await waitFor(() => expect(screen.getByTestId('kds-item-late').props.accessibilityLabel).toContain('En preparación'));
  });

  it('a failed update rolls the row back and shows an error toast', async () => {
    mockGet.mockResolvedValue(queue());
    mockPatch.mockRejectedValue(new ApiError({ status: 500, code: 'HTTP_500', message: 'boom' }));
    await show(<KdsScreen fixedStation="KITCHEN" />);
    await screen.findByText('Hamburguesa');
    await fireEvent.press(screen.getByTestId('kds-item-late'));
    expect(await screen.findByText('No se pudo actualizar el producto')).toBeTruthy();
    expect(screen.getByTestId('kds-item-late').props.accessibilityLabel).toContain('Enviado');
  });

  it('409 ITEM_VOIDED removes the item and says "Producto cancelado"', async () => {
    // the server (B3) no longer lists the voided line on the follow-up refetch
    mockGet.mockResolvedValueOnce(queue()).mockResolvedValue(queue().filter((i) => i.id !== 'late'));
    mockPatch.mockRejectedValue(new ApiError({ status: 409, code: 'ITEM_VOIDED', message: 'voided' }));
    await show(<KdsScreen fixedStation="KITCHEN" />);
    await screen.findByText('Hamburguesa');
    await fireEvent.press(screen.getByTestId('kds-item-late'));
    expect(await screen.findByText('Producto cancelado')).toBeTruthy();
    expect(screen.queryByTestId('kds-item-late')).toBeNull();
  });

  it('"Todo listo" with a not-started item asks first, then PATCHes IN_PROGRESS then READY in order', async () => {
    mockGet.mockResolvedValue([qi({ id: 'a', ticket_id: 'tA', resource_code: 'M2' })]);
    await show(<KdsScreen fixedStation="KITCHEN" />);
    await screen.findByText('M2');
    await fireEvent.press(screen.getByTestId('kds-all-ready-M2'));
    expect(await screen.findByText('¿Marcar todo como listo?')).toBeTruthy();
    expect(mockPatch).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledTimes(2));
    expect(mockPatch.mock.calls.map((c) => c[1])).toEqual(['IN_PROGRESS', 'READY']);
  });

  it('"Todo listo" with only started items needs no confirmation', async () => {
    mockGet.mockResolvedValue([qi({ id: 'a', ticket_id: 'tA', resource_code: 'M2', status: 'IN_PROGRESS' })]);
    await show(<KdsScreen fixedStation="KITCHEN" />);
    await screen.findByText('M2');
    await fireEvent.press(screen.getByTestId('kds-all-ready-M2'));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('a', 'READY'));
    expect(screen.queryByText('¿Marcar todo como listo?')).toBeNull();
  });

  it('READY -> SERVED only through the explicit "Entregado" button', async () => {
    mockGet.mockResolvedValue([qi({ id: 'a', ticket_id: 'tA', resource_code: 'M2', status: 'READY' })]);
    await show(<KdsScreen fixedStation="KITCHEN" />);
    await screen.findByText('M2');
    await fireEvent.press(screen.getByTestId('kds-item-a')); // tapping a READY row does nothing
    expect(mockPatch).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('kds-served-M2'));
    await waitFor(() => expect(mockPatch).toHaveBeenCalledWith('a', 'SERVED'));
  });

  it('offline: advancing is blocked and explained', async () => {
    mockGet.mockResolvedValue(queue());
    await show(<KdsScreen fixedStation="KITCHEN" />);
    await screen.findByText('Hamburguesa');
    await act(async () => {
      useConnectionStore.setState({ state: 'disconnected' });
    });
    await fireEvent.press(screen.getByTestId('kds-item-late'));
    expect(await screen.findByText('Sin conexión: no se puede avanzar el pedido')).toBeTruthy();
    expect(mockPatch).not.toHaveBeenCalled();
  });

  it('empty queue shows the calm state; station switch only for roles without a fixed station', async () => {
    mockGet.mockResolvedValue([]);
    await show(<KdsScreen tabs />);
    expect(await screen.findByTestId('kds-empty')).toBeTruthy();
    expect(screen.getByText('Sin pedidos pendientes')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('station-BAR'));
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith('BAR'));
  });

  it('fixed station (kitchen/bar staff) has no switch', async () => {
    mockGet.mockResolvedValue([]);
    await show(<KdsScreen fixedStation="BAR" />);
    await screen.findByTestId('kds-empty');
    expect(screen.queryByTestId('station-KITCHEN')).toBeNull();
    expect(mockGet).toHaveBeenCalledWith('BAR');
  });

  it('first load error shows retry', async () => {
    mockGet.mockRejectedValue(new ApiError({ code: 'NETWORK_ERROR', message: '', isNetwork: true }));
    await show(<KdsScreen fixedStation="KITCHEN" />);
    expect(await screen.findByTestId('error-state', undefined, { timeout: 4000 })).toBeTruthy();
  });
});
