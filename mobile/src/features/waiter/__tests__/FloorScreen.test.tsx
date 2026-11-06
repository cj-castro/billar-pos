import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { useAuthStore } from '../../../state/authStore';
import { FloorScreen } from '../floor/FloorScreen';
import { httpError, makeRouter, mockApi, online, renderScreen, resource, setOnline, ticket } from '../testing/testkit';

const mockRouter = makeRouter();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const resources = [
  resource({ id: 'bt1', code: 'BT1', type: 'POOL_TABLE', status: 'IN_USE', active_ticket_id: 'tk-bt1', customer_name: 'Carlos', timer_start: new Date(Date.now() - 3_725_000).toISOString() }),
  resource({ id: 'bt2', code: 'BT2', type: 'POOL_TABLE', status: 'AVAILABLE', active_ticket_id: 'tk-bt2' }), // bill requested: pool freed, ticket OPEN
  resource({ id: 'bt3', code: 'BT3', type: 'POOL_TABLE', status: 'AVAILABLE' }),
  resource({ id: 't1', code: 'T1', status: 'IN_USE', active_ticket_id: 'tk-t1', customer_name: 'Fam. Ruiz' }),
  resource({ id: 't2', code: 'T2' }),
  resource({ id: 't3', code: 'T3', status: 'INACTIVE' }),
  resource({ id: 'b1', code: 'B1', type: 'BAR_SEAT' }),
];
const pending = [ticket({ id: 'tk-bt2', resource_id: 'bt2', resource_code: 'BT2', total_cents: 33000, payment_requested: true })];

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  useAuthStore.setState({ user: { id: 'u-waiter', username: 'waiter1', name: 'Mariana R.', role: 'WAITER' } });
});

const api = (cashOpen = true) =>
  mockApi({
    'GET /resources': { data: resources },
    'GET /tickets/pending-payment': { data: pending },
    'GET /cash/status': { data: { open: cashOpen, session: null, open_tickets_count: 0, ghost_tickets_count: 0 } },
  });

describe('FloorScreen', () => {
  it('groups Billar / Mesas / Barra with the derived table state', async () => {
    api();
    await renderScreen(<FloorScreen />);
    expect(await screen.findByTestId('floor-section-POOL')).toBeTruthy();
    expect(screen.getByTestId('floor-section-TABLE')).toBeTruthy();
    expect(screen.getByTestId('floor-section-BAR')).toBeTruthy();
    expect(screen.getByText('BILLAR')).toBeTruthy();
    expect(screen.getByText('MESAS')).toBeTruthy();
    expect(screen.getByText('BARRA')).toBeTruthy();
    expect(screen.getByTestId('floor-card-BT1').props.accessibilityLabel).toContain('Ocupada');
    expect(screen.getByTestId('floor-card-BT1').props.accessibilityLabel).toContain('Carlos');
    expect(screen.getByTestId('floor-card-BT2').props.accessibilityLabel).toContain('Cuenta solicitada'); // pool AVAILABLE + pending ticket
    expect(screen.getByTestId('floor-card-BT3').props.accessibilityLabel).toContain('Libre');
    expect(screen.getByTestId('floor-card-T3').props.accessibilityLabel).toContain('Inactiva');
    expect(screen.getByText('Mariana R. · Mesero')).toBeTruthy();
  });

  it('shows the live pool timer labelled "estimado", and no timer once the bill is requested', async () => {
    api();
    await renderScreen(<FloorScreen />);
    await screen.findByTestId('floor-card-BT1');
    expect(screen.getAllByText('estimado')).toHaveLength(1);
    expect(screen.getByText(/^1:02:0\d$/)).toBeTruthy();
    expect(screen.getByTestId('floor-card-BT2').props.accessibilityLabel).not.toContain('tiempo');
  });

  it('lists every pending bill in the "Cuentas pendientes" strip and opens it', async () => {
    api();
    await renderScreen(<FloorScreen />);
    const chip = await screen.findByTestId('floor-pending-tk-bt2');
    expect(screen.getByText('CUENTAS PENDIENTES')).toBeTruthy();
    expect(chip.props.accessibilityLabel).toBe('Cuenta pendiente BT2, $330.00');
    await fireEvent.press(chip);
    expect(mockRouter.push).toHaveBeenCalledWith('/ticket/tk-bt2');
  });

  it('free table -> open-table sheet; occupied / bill -> its ticket; inactive does nothing', async () => {
    api();
    await renderScreen(<FloorScreen />);
    await screen.findByTestId('floor-card-T2');
    await fireEvent.press(screen.getByTestId('floor-card-T2'));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/open-table/t2');
    await fireEvent.press(screen.getByTestId('floor-card-T1'));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/ticket/tk-t1');
    await fireEvent.press(screen.getByTestId('floor-card-BT2'));
    expect(mockRouter.push).toHaveBeenLastCalledWith('/ticket/tk-bt2');
    mockRouter.push.mockClear();
    await fireEvent.press(screen.getByTestId('floor-card-T3'));
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('manager mode is read-only: no "Abrir mesa", occupied still opens', async () => {
    api();
    const onOpenTicket = jest.fn();
    await renderScreen(<FloorScreen mode="manager" onOpenTicket={onOpenTicket} />);
    await screen.findByTestId('floor-card-T2');
    await fireEvent.press(screen.getByTestId('floor-card-T2'));
    expect(mockRouter.push).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('floor-card-T1'));
    expect(onOpenTicket).toHaveBeenCalledWith('tk-t1');
  });

  it('shows the amber "Bar cerrado" banner when the cash session is closed', async () => {
    api(false);
    await renderScreen(<FloorScreen />);
    const banner = await screen.findByTestId('floor-bar-closed');
    expect(banner.props.accessibilityLabel).toContain('Bar cerrado');
    expect(banner.props.accessibilityLabel).toContain('Pide a un gerente que abra turno');
  });

  it('no banner while the bar is open', async () => {
    api(true);
    await renderScreen(<FloorScreen />);
    await screen.findByTestId('floor-card-T2');
    expect(screen.queryByTestId('floor-bar-closed')).toBeNull();
  });

  it('first load shows skeletons', async () => {
    let release: (v: { data: unknown }) => void = () => {};
    mockApi({ 'GET /resources': () => new Promise((r) => (release = r)), 'GET /tickets/pending-payment': { data: [] }, 'GET /cash/status': { data: { open: true } } });
    await renderScreen(<FloorScreen />);
    expect(screen.getByTestId('loading-skeleton')).toBeTruthy();
    await act(async () => release({ data: resources }));
    expect(await screen.findByTestId('floor-card-T2')).toBeTruthy();
  });

  it('empty floor shows the empty state', async () => {
    mockApi({ 'GET /resources': { data: [] }, 'GET /tickets/pending-payment': { data: [] }, 'GET /cash/status': { data: { open: true } } });
    await renderScreen(<FloorScreen />);
    expect(await screen.findByTestId('floor-empty')).toBeTruthy();
    expect(screen.getByText('No hay mesas configuradas')).toBeTruthy();
  });

  it('server failure with no cache -> ErrorState with retry that refetches', async () => {
    let fail = true;
    mockApi({
      'GET /resources': () => (fail ? httpError(500, 'X') : { data: resources }),
      'GET /tickets/pending-payment': { data: [] },
      'GET /cash/status': { data: { open: true } },
    });
    await renderScreen(<FloorScreen />);
    // react-query retries once (retry: 1) before surfacing the error
    expect(await screen.findByTestId('error-state', {}, { timeout: 4000 })).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByText('Reintentar'));
    await waitFor(() => expect(screen.getByTestId('floor-card-T2')).toBeTruthy());
  });

  it('offline: stale tiles + banner, but the cached floor stays visible', async () => {
    api();
    online(true);
    await renderScreen(<FloorScreen />);
    await screen.findByTestId('floor-card-T2');
    await setOnline(false);
    await waitFor(() => expect(screen.getByTestId('offline-banner')).toBeTruthy());
    expect(screen.getByTestId('floor-card-T2')).toBeTruthy();
  });
});
