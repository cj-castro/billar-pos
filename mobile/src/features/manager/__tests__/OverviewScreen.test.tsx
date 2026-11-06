import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from '../../../api/client';
import { getCashStatus } from '../../../api/endpoints/cash';
import { listOpenAll, listPendingPayment } from '../../../api/endpoints/managerTickets';
import { getCounts, getQueue } from '../../../api/endpoints/queue';
import { useConnectionStore } from '../../../realtime/socket';
import { useAuthStore } from '../../../state/authStore';
import { renderWithProviders } from '../../../test/utils';
import { qi } from '../../kitchen/testFixtures';
import { OverviewScreen } from '../OverviewScreen';
import { usePrintFailures } from '../printFailures';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('../../../api/endpoints/cash');
jest.mock('../../../api/endpoints/managerTickets');
jest.mock('../../../api/endpoints/queue');

const clients: { clear: () => void }[] = [];
const cash = {
  open: true,
  session: { id: 's', date: '2026-11-05', status: 'OPEN', opening_fund_cents: 50000, closing_cash_counted_cents: null, opened_by: 'u', closed_by: null, opened_at: '2026-11-05T14:00:00+00:00', closed_at: null, notes: null },
  open_tickets_count: 2,
  ghost_tickets_count: 1,
};
const openAll = [
  { id: 't1', resource_code: 'M1', resource_status: 'IN_USE', customer_name: null, opened_at: '2026-11-05T19:00:00+00:00', item_count: 2, total_cents: 12000 },
  { id: 't2', resource_code: 'M2', resource_status: 'IN_USE', customer_name: 'Ana', opened_at: '2026-11-05T19:30:00+00:00', item_count: 1, total_cents: 5000 },
];

beforeEach(() => {
  jest.clearAllMocks();
  useConnectionStore.setState({ state: 'connected', lastConnectedAt: Date.now() });
  useAuthStore.setState({ user: { id: 'm', username: 'manager', name: 'Gerente', role: 'MANAGER' } });
  usePrintFailures.getState().clear();
  (getCashStatus as jest.Mock).mockResolvedValue(cash);
  (listOpenAll as jest.Mock).mockResolvedValue(openAll);
  (listPendingPayment as jest.Mock).mockResolvedValue([{ id: 't1' }]);
  (getCounts as jest.Mock).mockResolvedValue({ kitchen: 5, bar: 3 });
  (getQueue as jest.Mock).mockImplementation(async (st: string) =>
    st === 'KITCHEN' ? [qi({ id: 'old', sent_at: new Date(Date.now() - 25 * 60000).toISOString() })] : [],
  );
});
afterEach(() => {
  clients.splice(0).forEach((c) => c.clear());
  useAuthStore.setState({ user: null });
});

const label = (id: string) => screen.getByTestId(id).props.accessibilityLabel as string;

async function show() {
  const r = await renderWithProviders(<OverviewScreen />);
  clients.push(r.queryClient);
  await screen.findByTestId('overview-scroll');
  await waitFor(() => expect(label('tile-open')).toContain('2'));
}

describe('OverviewScreen', () => {
  it('shows tiles that match the API values and the cash card', async () => {
    await show();
    expect(label('tile-open')).toBe('Tickets abiertos: 2, Total abierto $170.00');
    expect(label('tile-bills')).toBe('Cuentas solicitadas: 1');
    expect(label('tile-kitchen')).toBe('Cocina: 5, en cola');
    expect(label('tile-bar')).toBe('Barra: 3, en cola');
    expect(label('cash-card')).toBe('Caja abierta');
    expect(screen.getByText('Fondo $500.00', { exact: false })).toBeTruthy();
    expect(screen.getByTestId('oldest-item')).toBeTruthy();
  });

  it('derives alerts: old item (>20 min) and ghost ticket; no "no alerts" row', async () => {
    await show();
    expect(await screen.findByTestId('alert-old_items')).toBeTruthy();
    expect(screen.getByText('1 producto con más de 20 min sin salir')).toBeTruthy();
    expect(screen.getByText('1 ticket fantasma abierto')).toBeTruthy();
    expect(screen.queryByTestId('alerts-none')).toBeNull();
  });

  it('closed cash -> warning card + alert', async () => {
    (getCashStatus as jest.Mock).mockResolvedValue({ open: false, session: null, open_tickets_count: 0, ghost_tickets_count: 0 });
    await renderWithProviders(<OverviewScreen />);
    expect(await screen.findByText('Caja cerrada')).toBeTruthy();
    expect(screen.getByText('No hay turno abierto')).toBeTruthy();
    expect(await screen.findByText('Caja cerrada · nadie puede abrir mesas')).toBeTruthy();
  });

  it('a socket print:failed event becomes a dismissible alert', async () => {
    await show();
    await act(async () => {
      usePrintFailures.getState().add({ id: 'j1', type: 'CHIT', error: 'agente apagado', ticketId: null, at: Date.now() });
    });
    expect(await screen.findByText('Falla de impresión: agente apagado')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('alert-dismiss-j1'));
    await waitFor(() => expect(screen.queryByText('Falla de impresión: agente apagado')).toBeNull());
  });

  it('a failing endpoint shows "-" on its tile (never 0) plus a banner; others stay', async () => {
    (listOpenAll as jest.Mock).mockRejectedValue(new ApiError({ status: 403, code: 'FORBIDDEN', message: '' }));
    await renderWithProviders(<OverviewScreen />);
    await screen.findByTestId('overview-scroll');
    await waitFor(() => expect(label('tile-bills')).toBe('Cuentas solicitadas: 1'));
    await waitFor(() => expect(screen.getByTestId('overview-partial-error')).toBeTruthy(), { timeout: 4000 });
    // open-all failed: the cash counter still gives the count, but no total
    expect(label('tile-open')).toBe('Tickets abiertos: 2');
    expect(label('tile-kitchen')).toBe('Cocina: 5, en cola');
  });

  it('every endpoint failing -> ErrorState with retry', async () => {
    const boom = new ApiError({ code: 'NETWORK_ERROR', message: '', isNetwork: true });
    for (const f of [getCashStatus, listOpenAll, listPendingPayment, getCounts, getQueue]) (f as jest.Mock).mockRejectedValue(boom);
    await renderWithProviders(<OverviewScreen />);
    expect(await screen.findByTestId('error-state', undefined, { timeout: 5000 })).toBeTruthy();
  });

  it('tiles navigate to the lists', async () => {
    await show();
    await fireEvent.press(screen.getByTestId('tile-open'));
    expect(mockPush).toHaveBeenCalledWith('/tickets');
    await fireEvent.press(screen.getByTestId('tile-bills'));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/tickets', params: { filter: 'bills' } });
    await fireEvent.press(screen.getByTestId('tile-kitchen'));
    expect(mockPush).toHaveBeenCalledWith('/kds');
  });

  it('admin goes to the kitchen group display (no kds tab)', async () => {
    useAuthStore.setState({ user: { id: 'a', username: 'admin', name: 'Admin', role: 'ADMIN' } });
    await show();
    await fireEvent.press(screen.getByTestId('tile-bar'));
    expect(mockPush).toHaveBeenCalledWith('/queue');
  });
});
